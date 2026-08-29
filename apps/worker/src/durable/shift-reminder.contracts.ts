import { assertDurableInstanceId } from './payload-policy.js';

export const SHIFT_REMINDER_ORCHESTRATION_VERSION = '1.0.0';
export const SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR = 'ShiftReminderScheduleOrchestratorV1';
export const SHIFT_REMINDER_SWEEP_ORCHESTRATOR = 'ShiftReminderSweepOrchestratorV1';
export const SEND_SHIFT_REMINDER_ORCHESTRATOR = 'SendShiftReminderOrchestratorV1';

export const CALCULATE_NEXT_SHIFT_REMINDER_FIRE_ACTIVITY =
  'calculateNextShiftReminderFireActivityV1';
export const FIND_UPCOMING_SHIFTS_ACTIVITY = 'findUpcomingShiftsActivityV1';
export const LOAD_SHIFT_REMINDER_CONTEXT_ACTIVITY = 'loadShiftReminderContextActivityV1';
export const MARK_SHIFT_REMINDER_SENT_ACTIVITY = 'markShiftReminderSentActivityV1';
export const POST_MATTERMOST_MESSAGE_ACTIVITY = 'postMattermostMessageActivityV1';
export const PROCESS_SHIFT_REMINDER_DELIVERY_ACTIVITY = 'processShiftReminderDeliveryActivityV1';
export const START_SHIFT_REMINDER_SWEEP_ACTIVITY = 'startShiftReminderSweepActivityV1';
export const START_SHIFT_REMINDER_DELIVERY_ACTIVITY = 'startShiftReminderDeliveryActivityV1';

export interface ShiftReminderScheduleInput {
  readonly intervalSeconds?: number;
  readonly maxLookaheadMinutes?: number;
  readonly minLookaheadMinutes?: number;
}

export interface CalculateNextShiftReminderFireInput {
  readonly afterIso: string;
  readonly intervalSeconds: number;
}

export interface StartShiftReminderSweepInput {
  readonly correlationId: string;
  readonly maxLookaheadMinutes: number;
  readonly minLookaheadMinutes: number;
  readonly scheduledForIso: string;
  readonly sweepInstanceId: string;
}

export interface ShiftReminderSweepInput {
  readonly correlationId: string;
  readonly maxLookaheadMinutes: number;
  readonly minLookaheadMinutes: number;
  readonly scheduledForIso: string;
}

export interface StartShiftReminderDeliveryInput {
  readonly correlationId: string;
  readonly deliveryInstanceId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly tenantId: string;
}

export interface ShiftReminderDeliveryInput {
  readonly correlationId: string;
  readonly homeId: string;
  readonly shiftId: string;
  readonly tenantId: string;
}

export interface ProcessShiftReminderDeliveryInput extends ShiftReminderDeliveryInput {
  readonly nowIso: string;
}

export interface ShiftReminderDeliveryResult {
  readonly dispatched: boolean;
  readonly outcomeCode?:
    | 'already-reminded'
    | 'provider-not-delivered'
    | 'reminder-already-recorded'
    | 'shift-not-found';
}

export function shiftReminderSweepInstanceId(scheduledForIso: string): string {
  const scheduledFor = new Date(scheduledForIso);
  if (Number.isNaN(scheduledFor.getTime())) {
    throw new Error('Shift reminder scheduledForIso must be a valid ISO timestamp.');
  }
  const compactTimestamp = scheduledFor.toISOString().replaceAll(/[-:.]/g, '');
  return assertDurableInstanceId(`shift-reminder-sweep:${compactTimestamp}`);
}

export function shiftReminderDeliveryInstanceId(shiftId: string): string {
  return assertDurableInstanceId(`shift-reminder:${shiftId}`);
}
