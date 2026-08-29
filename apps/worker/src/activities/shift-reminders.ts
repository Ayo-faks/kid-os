// Phase 3 §2 (D3 wiring) — scheduled shift-reminder activities.

import type {
  FindUpcomingShiftsInput,
  FindUpcomingShiftsResult,
  LoadShiftReminderContextInput,
  MarkShiftReminderSentInput,
  MarkShiftReminderSentResult,
  ShiftReminderContext,
  UpcomingShift,
} from '@careos/contracts';

import { withSystemContext, withTenantContext } from '../db/pg.js';

interface UpcomingShiftRow {
  readonly tenant_id: string;
  readonly home_id: string;
  readonly id: string;
  readonly starts_at: Date;
  readonly required_role: string;
  readonly min_headcount: number;
}

export async function findUpcomingShifts(
  input: FindUpcomingShiftsInput,
): Promise<FindUpcomingShiftsResult> {
  const now = new Date(input.nowIso);
  const lo = new Date(now.getTime() + input.minLookaheadMinutes * 60_000);
  const hi = new Date(now.getTime() + input.maxLookaheadMinutes * 60_000);

  const rows = await withSystemContext({ correlationId: input.correlationId }, async (client) => {
    const result = await client.query<UpcomingShiftRow>(
      `SELECT id, tenant_id, home_id, starts_at, required_role, min_headcount
           FROM core.shifts
          WHERE reminder_sent_at IS NULL
            AND starts_at >= $1
            AND starts_at <  $2
          ORDER BY starts_at ASC, id ASC
          LIMIT 200`,
      [lo.toISOString(), hi.toISOString()],
    );
    return result.rows;
  });

  const shifts: UpcomingShift[] = rows.map((row) => ({
    homeId: row.home_id,
    minHeadcount: row.min_headcount,
    requiredRole: row.required_role,
    shiftId: row.id,
    startsAtIso: row.starts_at.toISOString(),
    tenantId: row.tenant_id,
  }));

  return { shifts };
}

interface ShiftContextRow {
  readonly id: string;
  readonly starts_at: Date;
  readonly required_role: string;
  readonly min_headcount: number;
  readonly reminder_sent_at: Date | null;
  readonly assigned_headcount: string; // pg returns COUNT as string
}

export async function loadShiftReminderContext(
  input: LoadShiftReminderContextInput,
): Promise<ShiftReminderContext | null> {
  const row = await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<ShiftContextRow>(
        `SELECT s.id,
                s.starts_at,
                s.required_role,
                s.min_headcount,
                s.reminder_sent_at,
                (SELECT COUNT(*)::text
                   FROM core.shift_assignments sa
                  WHERE sa.shift_id = s.id
                    AND sa.state IN (
                      'confirmed'::"core"."ShiftAssignmentState",
                      'published'::"core"."ShiftAssignmentState"
                    )) AS assigned_headcount
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
    alreadyReminded: row.reminder_sent_at !== null,
    assignedHeadcount: Number(row.assigned_headcount),
    minHeadcount: row.min_headcount,
    requiredRole: row.required_role,
    shiftId: row.id,
    startsAtIso: row.starts_at.toISOString(),
  };
}

export async function markShiftReminderSent(
  input: MarkShiftReminderSentInput,
): Promise<MarkShiftReminderSentResult> {
  const updated = await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query(
        `UPDATE core.shifts
            SET reminder_sent_at = NOW()
          WHERE id = $1::uuid
            AND reminder_sent_at IS NULL`,
        [input.shiftId],
      );
      return (result.rowCount ?? 0) > 0;
    },
  );

  return { recorded: updated };
}
