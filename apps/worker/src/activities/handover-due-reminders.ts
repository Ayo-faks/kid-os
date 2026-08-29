// Phase 3 §2 (D3 slice 3) — overdue handover reminder activities.

import type {
  FindOverdueHandoverShiftsInput,
  FindOverdueHandoverShiftsResult,
  HandoverDueReminderContext,
  LoadHandoverDueReminderContextInput,
  MarkHandoverDueReminderSentInput,
  MarkHandoverDueReminderSentResult,
  OverdueHandoverShift,
} from '@careos/contracts';

import { withSystemContext, withTenantContext } from '../db/pg.js';

interface OverdueShiftRow {
  readonly tenant_id: string;
  readonly home_id: string;
  readonly id: string;
  readonly ends_at: Date;
  readonly required_role: string;
}

export async function findOverdueHandoverShifts(
  input: FindOverdueHandoverShiftsInput,
): Promise<FindOverdueHandoverShiftsResult> {
  const now = new Date(input.nowIso);
  // ends_at must lie in the past window [now-max, now-min].
  const lo = new Date(now.getTime() - input.maxOverdueMinutes * 60_000);
  const hi = new Date(now.getTime() - input.minOverdueMinutes * 60_000);

  const rows = await withSystemContext({ correlationId: input.correlationId }, async (client) => {
    const result = await client.query<OverdueShiftRow>(
      `SELECT s.id, s.tenant_id, s.home_id, s.ends_at, s.required_role
           FROM core.shifts s
          WHERE s.handover_due_reminder_sent_at IS NULL
            AND s.ends_at >= $1
            AND s.ends_at <  $2
            AND NOT EXISTS (
              SELECT 1 FROM core.handover_records hr
               WHERE hr.shift_id = s.id
            )
          ORDER BY s.ends_at ASC, s.id ASC
          LIMIT 200`,
      [lo.toISOString(), hi.toISOString()],
    );
    return result.rows;
  });

  const shifts: OverdueHandoverShift[] = rows.map((row) => ({
    endsAtIso: row.ends_at.toISOString(),
    homeId: row.home_id,
    requiredRole: row.required_role,
    shiftId: row.id,
    tenantId: row.tenant_id,
  }));

  return { shifts };
}

interface HandoverContextRow {
  readonly id: string;
  readonly ends_at: Date;
  readonly required_role: string;
  readonly handover_due_reminder_sent_at: Date | null;
  readonly handover_count: string;
}

export async function loadHandoverDueReminderContext(
  input: LoadHandoverDueReminderContextInput,
): Promise<HandoverDueReminderContext | null> {
  const row = await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<HandoverContextRow>(
        `SELECT s.id,
                s.ends_at,
                s.required_role,
                s.handover_due_reminder_sent_at,
                (SELECT COUNT(*)::text
                   FROM core.handover_records hr
                  WHERE hr.shift_id = s.id) AS handover_count
           FROM core.shifts s
          WHERE s.id = $1::uuid
          LIMIT 1`,
        [input.shiftId],
      );
      return result.rows[0] ?? null;
    },
  );

  if (row === null) {
    return null;
  }

  return {
    alreadyReminded: row.handover_due_reminder_sent_at !== null,
    endsAtIso: row.ends_at.toISOString(),
    handoverRecorded: Number(row.handover_count) > 0,
    requiredRole: row.required_role,
    shiftId: row.id,
  };
}

export async function markHandoverDueReminderSent(
  input: MarkHandoverDueReminderSentInput,
): Promise<MarkHandoverDueReminderSentResult> {
  const updated = await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query(
        `UPDATE core.shifts
            SET handover_due_reminder_sent_at = NOW()
          WHERE id = $1::uuid
            AND handover_due_reminder_sent_at IS NULL`,
        [input.shiftId],
      );
      return (result.rowCount ?? 0) > 0;
    },
  );

  return { recorded: updated };
}
