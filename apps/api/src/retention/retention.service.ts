import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import type {
  RetentionPoliciesResponse,
  RetentionPolicyResponse,
  RetentionRunsResponse,
  UpsertRetentionPolicyDto,
} from './dto.js';

interface RequestContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly correlationId: string;
  readonly actorUserId: string;
}

interface PolicyRow {
  readonly id: string;
  readonly recordType: 'incident' | 'handover_record' | 'email_draft' | 'attachment';
  readonly retentionDays: number;
  readonly action: 'soft_delete' | 'object_delete';
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RunRow {
  readonly action: 'soft_delete' | 'object_delete';
  readonly affectedCount: number;
  readonly completedAt: Date | null;
  readonly failureReason: string | null;
  readonly id: string;
  readonly recordType: 'incident' | 'handover_record' | 'email_draft' | 'attachment';
  readonly scannedCount: number;
  readonly startedAt: Date;
  readonly workflowId: string;
}

@Injectable()
export class RetentionService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(ctx: RequestContext): Promise<RetentionPoliciesResponse> {
    const rows = await this.prisma.withTenantContext(
      this.databaseContext(ctx),
      (transaction) => transaction.$queryRaw<PolicyRow[]>`
        SELECT
          id::text AS "id",
          record_type::text AS "recordType",
          retention_days AS "retentionDays",
          action::text AS "action",
          enabled,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
          FROM core.retention_policies
         WHERE tenant_id = ${ctx.tenantId}::uuid
         ORDER BY record_type ASC
      `,
    );

    return { policies: rows.map((row) => this.toResponse(row)) };
  }

  async listRuns(ctx: RequestContext): Promise<RetentionRunsResponse> {
    const rows = await this.prisma.withTenantContext(
      this.databaseContext(ctx),
      (transaction) => transaction.$queryRaw<RunRow[]>`
        SELECT
          id::text AS "id",
          workflow_id AS "workflowId",
          record_type::text AS "recordType",
          action::text AS "action",
          scanned_count AS "scannedCount",
          affected_count AS "affectedCount",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          failure_reason AS "failureReason"
        FROM core.retention_runs
        WHERE tenant_id = ${ctx.tenantId}::uuid
        ORDER BY started_at DESC
        LIMIT 100
      `,
    );

    return {
      runs: rows.map((row) => ({
        action: row.action,
        affectedCount: row.affectedCount,
        completedAt: row.completedAt?.toISOString() ?? null,
        failureReason: row.failureReason,
        id: row.id,
        recordType: row.recordType,
        scannedCount: row.scannedCount,
        startedAt: row.startedAt.toISOString(),
        workflowId: row.workflowId,
      })),
    };
  }

  async upsert(
    dto: UpsertRetentionPolicyDto,
    ctx: RequestContext,
  ): Promise<RetentionPolicyResponse> {
    const enabled = dto.enabled ?? true;
    const rows = await this.prisma.withTenantContext(
      this.databaseContext(ctx),
      (transaction) => transaction.$queryRaw<PolicyRow[]>`
        INSERT INTO core.retention_policies
          (tenant_id, record_type, retention_days, action, enabled, created_at, updated_at)
        VALUES (
          ${ctx.tenantId}::uuid,
          ${dto.record_type}::"core"."RetentionRecordType",
          ${dto.retention_days},
          ${dto.action}::"core"."RetentionAction",
          ${enabled},
          now(),
          now()
        )
        ON CONFLICT (tenant_id, record_type)
        DO UPDATE SET
          retention_days = EXCLUDED.retention_days,
          action = EXCLUDED.action,
          enabled = EXCLUDED.enabled,
          updated_at = now()
        RETURNING
          id::text AS "id",
          record_type::text AS "recordType",
          retention_days AS "retentionDays",
          action::text AS "action",
          enabled,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
    );

    const row = rows[0];
    if (row === undefined) {
      throw new Error('retention policy upsert produced no row');
    }
    return this.toResponse(row);
  }

  private toResponse(row: PolicyRow): RetentionPolicyResponse {
    return {
      action: row.action,
      createdAt: row.createdAt.toISOString(),
      enabled: row.enabled,
      id: row.id,
      recordType: row.recordType,
      retentionDays: row.retentionDays,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private databaseContext(ctx: RequestContext) {
    return {
      actor: { correlationId: ctx.correlationId, kind: 'user' as const, userId: ctx.actorUserId },
      homeId: ctx.homeId,
      tenantId: ctx.tenantId,
    };
  }
}
