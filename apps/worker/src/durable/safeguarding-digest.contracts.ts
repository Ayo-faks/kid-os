import { assertDurableInstanceId } from './payload-policy.js';

export const SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION = '1.0.0';
export const SAFEGUARDING_DIGEST_SCHEDULE_ORCHESTRATOR = 'SafeguardingDigestScheduleOrchestratorV1';
export const SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR = 'SafeguardingDigestSweepOrchestratorV1';
export const SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR = 'SendSafeguardingDigestOrchestratorV1';
export const CALCULATE_NEXT_SAFEGUARDING_DIGEST_FIRE_ACTIVITY =
  'calculateNextSafeguardingDigestFireActivityV1';
export const FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY = 'findSafeguardingDigestTargetsActivityV1';
export const PROCESS_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY =
  'processSafeguardingDigestDeliveryActivityV1';
export const START_SAFEGUARDING_DIGEST_SWEEP_ACTIVITY = 'startSafeguardingDigestSweepActivityV1';
export const START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY =
  'startSafeguardingDigestDeliveryActivityV1';

export interface SafeguardingDigestScheduleInput {
  readonly intervalSeconds?: number;
  readonly windowMinutes?: number;
}

export interface SafeguardingDigestSweepInput {
  readonly correlationId: string;
  readonly nowIso: string;
  readonly sinceIso: string;
}

export interface SafeguardingDigestTarget {
  readonly homeId: string;
  readonly tenantId: string;
}

export interface SafeguardingDigestDeliveryInput extends SafeguardingDigestTarget {
  readonly correlationId: string;
  readonly nowIso: string;
  readonly sinceIso: string;
}

export interface SafeguardingDigestDeliveryResult {
  readonly dispatched: boolean;
  readonly outcomeCode?: 'already-recorded' | 'audit-not-recorded' | 'provider-not-delivered';
}

export interface StartSafeguardingDigestSweepInput extends SafeguardingDigestSweepInput {
  readonly sweepInstanceId: string;
}

export interface StartSafeguardingDigestDeliveryInput extends SafeguardingDigestDeliveryInput {
  readonly deliveryInstanceId: string;
}

export interface CalculateNextSafeguardingDigestFireInput {
  readonly afterIso: string;
  readonly intervalSeconds?: number;
}

export function safeguardingDigestSweepInstanceId(nowIso: string): string {
  return assertDurableInstanceId(`safeguarding-digest-sweep:${nowIso}`);
}

export function safeguardingDigestDeliveryInstanceId(homeId: string, nowIso: string): string {
  const compactFireTime = nowIso.replaceAll(/[^0-9]/g, '').slice(0, 17);
  return assertDurableInstanceId(`safeguarding-digest:${homeId}:${compactFireTime}`);
}
