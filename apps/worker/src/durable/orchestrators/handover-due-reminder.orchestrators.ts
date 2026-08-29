import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
  whenAll,
} from '@microsoft/durabletask-js';

import {
  CALCULATE_NEXT_HANDOVER_DUE_FIRE_ACTIVITY,
  type CalculateNextHandoverDueFireInput,
  FIND_HANDOVER_DUE_TARGETS_ACTIVITY,
  type FindHandoverDueTargetsResult,
  HANDOVER_DUE_ORCHESTRATION_VERSION,
  type HandoverDueDeliveryInput,
  type HandoverDueDeliveryResult,
  type HandoverDueScheduleInput,
  type HandoverDueSweepInput,
  PROCESS_HANDOVER_DUE_DELIVERY_ACTIVITY,
  START_HANDOVER_DUE_DELIVERY_ACTIVITY,
  START_HANDOVER_DUE_SWEEP_ACTIVITY,
  type StartHandoverDueDeliveryInput,
  type StartHandoverDueSweepInput,
  handoverDueDeliveryInstanceId,
  handoverDueSweepInstanceId,
} from '../handover-due-reminder.contracts.js';
import { assertDurablePayload } from '../payload-policy.js';

const RETRY = new RetryPolicy({ firstRetryIntervalInMilliseconds: 2_000, maxNumberOfAttempts: 3 });

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* handoverDueScheduleOrchestrator(
  context: OrchestrationContext,
  input: HandoverDueScheduleInput = {},
): AsyncGenerator<Task<unknown>, void, unknown> {
  assertDurablePayload(input, 'handoverDueSchedule');
  const intervalSeconds = input.intervalSeconds ?? 600;
  const maxOverdueMinutes = input.maxOverdueMinutes ?? 240;
  const minOverdueMinutes = input.minOverdueMinutes ?? 15;
  const next = yield context.callActivity<CalculateNextHandoverDueFireInput, string>(
    CALCULATE_NEXT_HANDOVER_DUE_FIRE_ACTIVITY,
    { afterIso: context.currentUtcDateTime.toISOString(), intervalSeconds },
    { retry: RETRY, version: HANDOVER_DUE_ORCHESTRATION_VERSION },
  );
  if (typeof next !== 'string') throw new Error('Handover due next fire result is invalid.');
  context.setCustomStatus({ kind: 'handover-due-schedule', nextFireAtIso: next });
  yield context.createTimer(new Date(next));
  const sweepInstanceId = handoverDueSweepInstanceId(next);
  yield context.callActivity<StartHandoverDueSweepInput, string>(
    START_HANDOVER_DUE_SWEEP_ACTIVITY,
    {
      correlationId: sweepInstanceId,
      maxOverdueMinutes,
      minOverdueMinutes,
      scheduledForIso: next,
      sweepInstanceId,
    },
    { retry: RETRY, version: HANDOVER_DUE_ORCHESTRATION_VERSION },
  );
  context.continueAsNew(input, false);
}

export const HandoverDueScheduleOrchestrator =
  handoverDueScheduleOrchestrator as unknown as TOrchestrator;

interface SweepResult {
  readonly deliveryInstanceIds: readonly string[];
  readonly scanned: number;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* handoverDueSweepOrchestrator(
  context: OrchestrationContext,
  input: HandoverDueSweepInput,
): AsyncGenerator<Task<unknown>, SweepResult, unknown> {
  assertDurablePayload(input, 'handoverDueSweep');
  const found = yield context.callActivity<
    Omit<HandoverDueSweepInput, 'scheduledForIso'> & { readonly nowIso: string },
    FindHandoverDueTargetsResult
  >(
    FIND_HANDOVER_DUE_TARGETS_ACTIVITY,
    {
      correlationId: input.correlationId,
      maxOverdueMinutes: input.maxOverdueMinutes,
      minOverdueMinutes: input.minOverdueMinutes,
      nowIso: context.currentUtcDateTime.toISOString(),
    },
    { retry: RETRY, version: HANDOVER_DUE_ORCHESTRATION_VERSION },
  );
  const targets = parseTargets(found);
  const starts = targets.map((target) => {
    const deliveryInstanceId = handoverDueDeliveryInstanceId(target.shiftId);
    return context.callActivity<StartHandoverDueDeliveryInput, string>(
      START_HANDOVER_DUE_DELIVERY_ACTIVITY,
      {
        ...target,
        correlationId: `${input.correlationId}:${target.shiftId}`,
        deliveryInstanceId,
      },
      { retry: RETRY, version: HANDOVER_DUE_ORCHESTRATION_VERSION },
    );
  });
  const started = starts.length === 0 ? [] : yield whenAll(starts);
  if (!Array.isArray(started) || !started.every((value) => typeof value === 'string')) {
    throw new Error('Handover due delivery starts returned an invalid result.');
  }
  return { deliveryInstanceIds: started, scanned: targets.length };
}

export const HandoverDueSweepOrchestrator =
  handoverDueSweepOrchestrator as unknown as TOrchestrator;

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* sendHandoverDueOrchestrator(
  context: OrchestrationContext,
  input: HandoverDueDeliveryInput,
): AsyncGenerator<Task<unknown>, HandoverDueDeliveryResult, unknown> {
  assertDurablePayload(input, 'handoverDueDelivery');
  const result = yield context.callActivity<
    HandoverDueDeliveryInput & { readonly nowIso: string },
    HandoverDueDeliveryResult
  >(
    PROCESS_HANDOVER_DUE_DELIVERY_ACTIVITY,
    { ...input, nowIso: context.currentUtcDateTime.toISOString() },
    { retry: RETRY, version: HANDOVER_DUE_ORCHESTRATION_VERSION },
  );
  return parseDeliveryResult(result);
}

export const SendHandoverDueOrchestrator = sendHandoverDueOrchestrator as unknown as TOrchestrator;

function parseTargets(value: unknown): readonly FindHandoverDueTargetsResult['targets'][number][] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Handover due target lookup returned an invalid result.');
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => key !== 'targets') || !Array.isArray(result.targets)) {
    throw new Error('Handover due target lookup returned an invalid result.');
  }
  const targets = result.targets.map((value) => {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Handover due target lookup returned an invalid result.');
    }
    const target = value as Record<string, unknown>;
    if (
      Object.keys(target).some((key) => !['homeId', 'shiftId', 'tenantId'].includes(key)) ||
      typeof target.homeId !== 'string' ||
      typeof target.shiftId !== 'string' ||
      typeof target.tenantId !== 'string'
    ) {
      throw new Error('Handover due target lookup returned an invalid result.');
    }
    return { homeId: target.homeId, shiftId: target.shiftId, tenantId: target.tenantId };
  });
  return targets;
}

function parseDeliveryResult(value: unknown): HandoverDueDeliveryResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Handover due delivery returned an invalid result.');
  }
  const result = value as Record<string, unknown>;
  const outcomeCodes = [
    'already-reminded',
    'handover-already-recorded',
    'provider-not-delivered',
    'reminder-already-recorded',
    'shift-not-found',
  ];
  if (
    Object.keys(result).some((key) => !['dispatched', 'outcomeCode'].includes(key)) ||
    typeof result.dispatched !== 'boolean' ||
    (result.outcomeCode !== undefined &&
      (typeof result.outcomeCode !== 'string' || !outcomeCodes.includes(result.outcomeCode)))
  ) {
    throw new Error('Handover due delivery returned an invalid result.');
  }
  const parsed: HandoverDueDeliveryResult = {
    dispatched: result.dispatched,
    ...(result.outcomeCode === undefined
      ? {}
      : { outcomeCode: result.outcomeCode as HandoverDueDeliveryResult['outcomeCode'] }),
  };
  assertDurablePayload(parsed, 'handoverDueDeliveryResult');
  return parsed;
}
