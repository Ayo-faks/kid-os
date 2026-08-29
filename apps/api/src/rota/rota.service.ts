import { randomUUID } from 'node:crypto';

import { rotaPublishWorkflowId } from '@careos/contracts';
import type { RotaActor } from '@careos/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  type RotaWorkflowRuntime,
  WORKFLOW_RUNTIME,
} from '../workflow-runtime/workflow-runtime.port.js';

import type {
  AnalyzeRotaDto,
  AnalyzeRotaResponse,
  CreateRotaRuleDto,
  PublishRotaDto,
  PublishRotaResponse,
  RotaOverviewResponse,
  RotaRuleResponse,
  RotaShiftResponse,
} from './dto.js';

interface RequestContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly authorUserId: string;
  readonly correlationId: string;
  readonly actor: RotaActor;
}

interface ShiftRow {
  readonly id: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly requiredRole: string;
  readonly minHeadcount: number;
  readonly assignedUserIds: string[] | null;
}

interface RuleRow {
  readonly id: string;
  readonly name: string;
  readonly kind: 'min_staffing' | 'gender_mix' | 'qualification_flag';
  readonly parameters: unknown;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

@Injectable()
export class RotaService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(WORKFLOW_RUNTIME)
    private readonly workflowRuntime: RotaWorkflowRuntime,
  ) {}

  async analyze(dto: AnalyzeRotaDto, context: RequestContext): Promise<AnalyzeRotaResponse> {
    const result = await this.workflowRuntime.executeRotaAnalyzeWorkflow({
      actor: context.actor,
      correlationId: context.correlationId,
      homeId: context.homeId,
      periodEnd: dto.period_end,
      periodStart: dto.period_start,
      requestedByUserId: context.authorUserId,
      tenantId: context.tenantId,
    });

    return {
      correlationId: result.correlationId,
      gaps: result.gaps.map((gap) => ({ ...gap })),
      narration: result.narration,
      periodEnd: result.periodEnd,
      periodStart: result.periodStart,
      proposals: result.proposals.map((proposal) => ({
        addUserIds: [...proposal.addUserIds],
        reason: proposal.reason,
        removeUserIds: [...proposal.removeUserIds],
        resolvedGapKinds: [...proposal.resolvedGapKinds],
        shiftId: proposal.shiftId,
      })),
      shifts: result.shifts.map((shift) => ({
        assignedUserIds: [...shift.assignedUserIds],
        endsAt: shift.endsAt,
        id: shift.id,
        minHeadcount: shift.minHeadcount,
        requiredRole: shift.requiredRole,
        startsAt: shift.startsAt,
      })),
    };
  }

  async publish(dto: PublishRotaDto, context: RequestContext): Promise<PublishRotaResponse> {
    const publicationId = randomUUID();
    const started = await this.workflowRuntime.startRotaPublishWorkflow({
      actor: context.actor,
      correlationId: context.correlationId,
      homeId: context.homeId,
      note: dto.note,
      periodEnd: dto.period_end,
      periodStart: dto.period_start,
      publicationId,
      publishedByUserId: context.authorUserId,
      shiftIds: dto.shift_ids,
      tenantId: context.tenantId,
    });

    return {
      publicationId: started.publicationId,
      status: 'processing',
      workflowId: started.workflowId ?? rotaPublishWorkflowId(publicationId),
    };
  }

  async overview(from: string, to: string, context: RequestContext): Promise<RotaOverviewResponse> {
    const [shifts, rules] = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      async (transaction) => {
        const shiftRows = await transaction.$queryRaw<ShiftRow[]>`
        SELECT
          s.id::text AS "id",
          s.starts_at AS "startsAt",
          s.ends_at AS "endsAt",
          s.required_role AS "requiredRole",
          s.min_headcount AS "minHeadcount",
          (
            SELECT array_agg(sa.user_id::text ORDER BY sa.user_id)
              FROM core.shift_assignments sa
             WHERE sa.shift_id = s.id
          ) AS "assignedUserIds"
        FROM core.shifts s
        WHERE s.starts_at < ${to}::timestamp
          AND s.ends_at   > ${from}::timestamp
        ORDER BY s.starts_at ASC, s.id ASC
      `;

        const ruleRows = await transaction.$queryRaw<RuleRow[]>`
        SELECT
          id::text AS "id",
          name,
          kind::text AS "kind",
          parameters,
          active,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM core.rota_rules
        ORDER BY name ASC, id ASC
      `;
        return [shiftRows, ruleRows] as const;
      },
    );

    return {
      rules: rules.map(toRuleResponse),
      shifts: shifts.map(toShiftResponse),
    };
  }

  async createRule(dto: CreateRotaRuleDto, context: RequestContext): Promise<RotaRuleResponse> {
    const id = randomUUID();
    const active = dto.active ?? true;
    const row = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      async (transaction) => {
        const rows = await transaction.$queryRaw<RuleRow[]>`
        INSERT INTO core.rota_rules
          (id, tenant_id, home_id, name, kind, parameters, active, created_at, updated_at)
        VALUES (
          ${id}::uuid, ${context.tenantId}::uuid, ${context.homeId}::uuid,
          ${dto.name}, ${dto.kind}::"core"."RotaRuleKind",
          ${JSON.stringify(dto.parameters)}::jsonb, ${active}, now(), now()
        )
        RETURNING
          id::text AS "id",
          name,
          kind::text AS "kind",
          parameters,
          active,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;
        return rows[0];
      },
    );

    if (!row) {
      throw new Error('rota_rules insert returned no row');
    }
    return toRuleResponse(row);
  }
}

function toShiftResponse(row: ShiftRow): RotaShiftResponse {
  return {
    assignedUserIds: row.assignedUserIds ?? [],
    endsAt: row.endsAt.toISOString(),
    id: row.id,
    minHeadcount: row.minHeadcount,
    requiredRole: row.requiredRole,
    startsAt: row.startsAt.toISOString(),
  };
}

function toRuleResponse(row: RuleRow): RotaRuleResponse {
  return {
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    kind: row.kind,
    name: row.name,
    parameters: isRecord(row.parameters) ? row.parameters : {},
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
