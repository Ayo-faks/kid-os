// Phase 3 §2 (D3 wiring) — scheduled shift-reminder contracts.
//
// `ShiftReminderSweepWorkflow` runs on a Temporal cron schedule, asks
// `findUpcomingShifts` for shifts in the `[now + minLookaheadMinutes,
// now + maxLookaheadMinutes)` window that have not yet had a reminder
// dispatched, and starts one `SendShiftReminderWorkflow` per shift.
// Each child workflow runs under the originating tenant context so RLS
// and audit attribution stay intact.

import type { IncidentActor } from './incidents-workflow.js';

export interface FindUpcomingShiftsInput {
  readonly nowIso: string;
  readonly minLookaheadMinutes: number;
  readonly maxLookaheadMinutes: number;
  readonly correlationId: string;
}

export interface UpcomingShift {
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly startsAtIso: string;
  readonly requiredRole: string;
  readonly minHeadcount: number;
}

export interface FindUpcomingShiftsResult {
  readonly shifts: ReadonlyArray<UpcomingShift>;
}

export interface LoadShiftReminderContextInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly actor: IncidentActor;
}

export interface ShiftReminderContext {
  readonly shiftId: string;
  readonly startsAtIso: string;
  readonly requiredRole: string;
  readonly minHeadcount: number;
  readonly assignedHeadcount: number;
  readonly alreadyReminded: boolean;
}

export interface MarkShiftReminderSentInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly actor: IncidentActor;
}

export interface MarkShiftReminderSentResult {
  readonly recorded: boolean;
}
