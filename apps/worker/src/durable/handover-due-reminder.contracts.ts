import { assertDurableInstanceId } from './payload-policy.js';

export const HANDOVER_DUE_ORCHESTRATION_VERSION = '1.0.0';
export const HANDOVER_DUE_SCHEDULE_ORCHESTRATOR = 'HandoverDueScheduleOrchestratorV1';
export const HANDOVER_DUE_SWEEP_ORCHESTRATOR = 'HandoverDueSweepOrchestratorV1';
export const SEND_HANDOVER_DUE_ORCHESTRATOR = 'SendHandoverDueOrchestratorV1';
export const CALCULATE_NEXT_HANDOVER_DUE_FIRE_ACTIVITY = 'calculateNextHandoverDueFireActivityV1';
export const FIND_HANDOVER_DUE_TARGETS_ACTIVITY = 'findHandoverDueTargetsActivityV1';
export const START_HANDOVER_DUE_SWEEP_ACTIVITY = 'startHandoverDueSweepActivityV1';
export const START_HANDOVER_DUE_DELIVERY_ACTIVITY = 'startHandoverDueDeliveryActivityV1';
export const PROCESS_HANDOVER_DUE_DELIVERY_ACTIVITY = 'processHandoverDueDeliveryActivityV1';

export interface HandoverDueScheduleInput {
  readonly intervalSeconds?: number;
  readonly maxOverdueMinutes?: number;
  readonly minOverdueMinutes?: number;
}

export interface HandoverDueSweepInput {
  readonly correlationId: string;
  readonly maxOverdueMinutes: number;
  readonly minOverdueMinutes: number;
  readonly scheduledForIso: string;
}

export interface HandoverDueTarget {
  readonly homeId: string;
  readonly shiftId: string;
  readonly tenantId: string;
}

export interface FindHandoverDueTargetsInput {
  readonly correlationId: string;
  readonly maxOverdueMinutes: number;
  readonly minOverdueMinutes: number;
  readonly nowIso: string;
}

export interface FindHandoverDueTargetsResult {
  readonly targets: readonly HandoverDueTarget[];
}

export interface HandoverDueDeliveryInput extends HandoverDueTarget {
  readonly correlationId: string;
}

export interface HandoverDueDeliveryResult {
  readonly dispatched: boolean;
  readonly outcomeCode?:
    | 'already-reminded'
    | 'handover-already-recorded'
    | 'provider-not-delivered'
    | 'reminder-already-recorded'
    | 'shift-not-found';
}

export interface StartHandoverDueSweepInput extends HandoverDueSweepInput {
  readonly sweepInstanceId: string;
}

export interface StartHandoverDueDeliveryInput extends HandoverDueDeliveryInput {
  readonly deliveryInstanceId: string;
}

export interface CalculateNextHandoverDueFireInput {
  readonly afterIso: string;
  readonly intervalSeconds: number;
}

export function handoverDueSweepInstanceId(scheduledForIso: string): string {
  return assertDurableInstanceId(`handover-due-sweep:${scheduledForIso}`);
}

export function handoverDueDeliveryInstanceId(shiftId: string): string {
  return assertDurableInstanceId(`handover-due-reminder:${shiftId}`);
}
