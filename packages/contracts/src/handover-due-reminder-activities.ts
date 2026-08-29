// Phase 3 §2 (D3 slice 3) — shared contracts for the handover-due
// reminder sweep. Mirror of `shift-reminder-activities.ts` but keyed
// off `ends_at` + `handover_due_reminder_sent_at` and joined against
// `core.handover_records` to skip shifts that already have a handover.

import type { IncidentActor } from './incidents-workflow.js';

export interface FindOverdueHandoverShiftsInput {
  readonly nowIso: string;
  readonly minOverdueMinutes: number;
  readonly maxOverdueMinutes: number;
  readonly correlationId: string;
}

export interface OverdueHandoverShift {
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly endsAtIso: string;
  readonly requiredRole: string;
}

export interface FindOverdueHandoverShiftsResult {
  readonly shifts: readonly OverdueHandoverShift[];
}

export interface LoadHandoverDueReminderContextInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly actor: IncidentActor;
}

export interface HandoverDueReminderContext {
  readonly shiftId: string;
  readonly endsAtIso: string;
  readonly requiredRole: string;
  readonly handoverRecorded: boolean;
  readonly alreadyReminded: boolean;
}

export interface MarkHandoverDueReminderSentInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly actor: IncidentActor;
}

export interface MarkHandoverDueReminderSentResult {
  readonly recorded: boolean;
}
