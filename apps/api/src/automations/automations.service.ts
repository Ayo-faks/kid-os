import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import {
  AUTOMATION_ACTIONS,
  type AutomationAction,
  type RecentAutomationEvent,
  type RecentAutomationsResponse,
} from './dto.js';

export interface AutomationsRequestContext {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly correlationId: string;
}

interface AutomationRow {
  readonly id: string;
  readonly action: string;
  readonly occurredAt: Date;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly correlationId: string | null;
  readonly metadata: unknown;
}

@Injectable()
export class AutomationsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async listRecent(
    ctx: AutomationsRequestContext,
    limit: number,
  ): Promise<RecentAutomationsResponse> {
    const rows = await this.prisma.withTenantContext(
      {
        actor: { correlationId: ctx.correlationId, kind: 'user', userId: ctx.actorUserId },
        homeId: ctx.homeId,
        tenantId: ctx.tenantId,
      },
      (transaction) => transaction.$queryRaw<AutomationRow[]>`
        SELECT
          e.id::text          AS "id",
          e.action            AS "action",
          e.occurred_at       AS "occurredAt",
          e.subject_type      AS "subjectType",
          e.subject_id::text  AS "subjectId",
          e.correlation_id    AS "correlationId",
          e.metadata          AS "metadata"
          FROM audit.events e
         WHERE e.actor_kind = 'system'
           AND e.action IN (
             'shift.reminder_dispatched',
             'shift.handover_due_reminder_dispatched',
             'incident.missing_fields_reminder_dispatched',
             'safeguarding.weekly_digest_dispatched'
           )
         ORDER BY e.occurred_at DESC
         LIMIT ${limit}
      `,
    );

    const events: RecentAutomationEvent[] = rows
      .filter((row): row is AutomationRow & { action: AutomationAction } =>
        (AUTOMATION_ACTIONS as readonly string[]).includes(row.action),
      )
      .map((row) => ({
        action: row.action,
        correlationId: row.correlationId,
        id: row.id,
        metadata:
          row.metadata === null || typeof row.metadata !== 'object'
            ? null
            : (row.metadata as Record<string, unknown>),
        occurredAt: row.occurredAt.toISOString(),
        subjectId: row.subjectId,
        subjectType: row.subjectType,
      }));

    return { events };
  }
}
