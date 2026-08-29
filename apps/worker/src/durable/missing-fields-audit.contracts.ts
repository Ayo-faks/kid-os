import { assertDurableInstanceId } from './payload-policy.js';

export const MISSING_FIELDS_ORCHESTRATION_VERSION = '1.0.0';
export const MISSING_FIELDS_SCHEDULE_ORCHESTRATOR = 'MissingFieldsScheduleOrchestratorV1';
export const MISSING_FIELDS_SWEEP_ORCHESTRATOR = 'MissingFieldsSweepOrchestratorV1';
export const SEND_MISSING_FIELDS_ORCHESTRATOR = 'SendMissingFieldsOrchestratorV1';
export const CALCULATE_NEXT_MISSING_FIELDS_FIRE_ACTIVITY =
  'calculateNextMissingFieldsFireActivityV1';
export const FIND_MISSING_FIELDS_TARGETS_ACTIVITY = 'findMissingFieldsTargetsActivityV1';
export const PROCESS_MISSING_FIELDS_DELIVERY_ACTIVITY = 'processMissingFieldsDeliveryActivityV1';
export const START_MISSING_FIELDS_SWEEP_ACTIVITY = 'startMissingFieldsSweepActivityV1';
export const START_MISSING_FIELDS_DELIVERY_ACTIVITY = 'startMissingFieldsDeliveryActivityV1';

export interface MissingFieldsScheduleInput {
  readonly intervalSeconds?: number;
  readonly minAgeMinutes?: number;
}

export interface MissingFieldsSweepInput {
  readonly correlationId: string;
  readonly minAgeMinutes: number;
  readonly scheduledForIso: string;
}

export interface MissingFieldsTarget {
  readonly homeId: string;
  readonly incidentId: string;
  readonly tenantId: string;
}

export interface FindMissingFieldsTargetsInput {
  readonly correlationId: string;
  readonly minAgeMinutes: number;
  readonly nowIso: string;
}

export interface FindMissingFieldsTargetsResult {
  readonly targets: readonly MissingFieldsTarget[];
}

export interface MissingFieldsDeliveryInput extends MissingFieldsTarget {
  readonly correlationId: string;
}

export interface MissingFieldsDeliveryResult {
  readonly dispatched: boolean;
  readonly outcomeCode?:
    | 'already-reminded'
    | 'incident-not-found'
    | 'no-missing-fields'
    | 'provider-not-delivered'
    | 'reminder-already-recorded'
    | 'status-not-remindable';
}

export interface StartMissingFieldsSweepInput extends MissingFieldsSweepInput {
  readonly sweepInstanceId: string;
}

export interface StartMissingFieldsDeliveryInput extends MissingFieldsDeliveryInput {
  readonly deliveryInstanceId: string;
}

export interface CalculateNextMissingFieldsFireInput {
  readonly afterIso: string;
  readonly intervalSeconds: number;
}

export function missingFieldsSweepInstanceId(scheduledForIso: string): string {
  return assertDurableInstanceId(`missing-fields-sweep:${scheduledForIso}`);
}

export function missingFieldsDeliveryInstanceId(incidentId: string): string {
  return assertDurableInstanceId(`missing-fields-reminder:${incidentId}`);
}
