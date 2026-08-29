import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
  whenAll,
} from '@microsoft/durabletask-js';

import {
  CALCULATE_NEXT_MISSING_FIELDS_FIRE_ACTIVITY,
  type CalculateNextMissingFieldsFireInput,
  FIND_MISSING_FIELDS_TARGETS_ACTIVITY,
  type FindMissingFieldsTargetsResult,
  MISSING_FIELDS_ORCHESTRATION_VERSION,
  type MissingFieldsDeliveryInput,
  type MissingFieldsDeliveryResult,
  type MissingFieldsScheduleInput,
  type MissingFieldsSweepInput,
  PROCESS_MISSING_FIELDS_DELIVERY_ACTIVITY,
  START_MISSING_FIELDS_DELIVERY_ACTIVITY,
  START_MISSING_FIELDS_SWEEP_ACTIVITY,
  type StartMissingFieldsDeliveryInput,
  type StartMissingFieldsSweepInput,
  missingFieldsDeliveryInstanceId,
  missingFieldsSweepInstanceId,
} from '../missing-fields-audit.contracts.js';
import { assertDurablePayload } from '../payload-policy.js';

const RETRY = new RetryPolicy({ firstRetryIntervalInMilliseconds: 2_000, maxNumberOfAttempts: 3 });

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* missingFieldsScheduleOrchestrator(
  context: OrchestrationContext,
  input: MissingFieldsScheduleInput = {},
): AsyncGenerator<Task<unknown>, void, unknown> {
  assertDurablePayload(input, 'missingFieldsSchedule');
  const intervalSeconds = input.intervalSeconds ?? 3_600;
  const minAgeMinutes = input.minAgeMinutes ?? 1_440;
  const next = yield context.callActivity<CalculateNextMissingFieldsFireInput, string>(
    CALCULATE_NEXT_MISSING_FIELDS_FIRE_ACTIVITY,
    { afterIso: context.currentUtcDateTime.toISOString(), intervalSeconds },
    { retry: RETRY, version: MISSING_FIELDS_ORCHESTRATION_VERSION },
  );
  if (typeof next !== 'string') throw new Error('Missing fields next fire result is invalid.');
  context.setCustomStatus({ kind: 'missing-fields-schedule', nextFireAtIso: next });
  yield context.createTimer(new Date(next));
  const sweepInstanceId = missingFieldsSweepInstanceId(next);
  yield context.callActivity<StartMissingFieldsSweepInput, string>(
    START_MISSING_FIELDS_SWEEP_ACTIVITY,
    { correlationId: sweepInstanceId, minAgeMinutes, scheduledForIso: next, sweepInstanceId },
    { retry: RETRY, version: MISSING_FIELDS_ORCHESTRATION_VERSION },
  );
  context.continueAsNew(input, false);
}

export const MissingFieldsScheduleOrchestrator =
  missingFieldsScheduleOrchestrator as unknown as TOrchestrator;

interface SweepResult {
  readonly deliveryInstanceIds: readonly string[];
  readonly scanned: number;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* missingFieldsSweepOrchestrator(
  context: OrchestrationContext,
  input: MissingFieldsSweepInput,
): AsyncGenerator<Task<unknown>, SweepResult, unknown> {
  assertDurablePayload(input, 'missingFieldsSweep');
  const found = yield context.callActivity<
    Omit<MissingFieldsSweepInput, 'scheduledForIso'> & { readonly nowIso: string },
    FindMissingFieldsTargetsResult
  >(
    FIND_MISSING_FIELDS_TARGETS_ACTIVITY,
    {
      correlationId: input.correlationId,
      minAgeMinutes: input.minAgeMinutes,
      nowIso: context.currentUtcDateTime.toISOString(),
    },
    { retry: RETRY, version: MISSING_FIELDS_ORCHESTRATION_VERSION },
  );
  const targets = parseTargets(found);
  const starts = targets.map((target) => {
    const deliveryInstanceId = missingFieldsDeliveryInstanceId(target.incidentId);
    return context.callActivity<StartMissingFieldsDeliveryInput, string>(
      START_MISSING_FIELDS_DELIVERY_ACTIVITY,
      {
        ...target,
        correlationId: `${input.correlationId}:${target.incidentId}`,
        deliveryInstanceId,
      },
      { retry: RETRY, version: MISSING_FIELDS_ORCHESTRATION_VERSION },
    );
  });
  const started = starts.length === 0 ? [] : yield whenAll(starts);
  if (!Array.isArray(started) || !started.every((value) => typeof value === 'string')) {
    throw new Error('Missing fields delivery starts returned an invalid result.');
  }
  return { deliveryInstanceIds: started, scanned: targets.length };
}

export const MissingFieldsSweepOrchestrator =
  missingFieldsSweepOrchestrator as unknown as TOrchestrator;

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* sendMissingFieldsOrchestrator(
  context: OrchestrationContext,
  input: MissingFieldsDeliveryInput,
): AsyncGenerator<Task<unknown>, MissingFieldsDeliveryResult, unknown> {
  assertDurablePayload(input, 'missingFieldsDelivery');
  const result = yield context.callActivity<
    MissingFieldsDeliveryInput,
    MissingFieldsDeliveryResult
  >(PROCESS_MISSING_FIELDS_DELIVERY_ACTIVITY, input, {
    retry: RETRY,
    version: MISSING_FIELDS_ORCHESTRATION_VERSION,
  });
  return parseDeliveryResult(result);
}

export const SendMissingFieldsOrchestrator =
  sendMissingFieldsOrchestrator as unknown as TOrchestrator;

function parseTargets(
  value: unknown,
): readonly FindMissingFieldsTargetsResult['targets'][number][] {
  if (typeof value !== 'object' || value === null) throw invalidTargets();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => key !== 'targets') || !Array.isArray(result.targets)) {
    throw invalidTargets();
  }
  return result.targets.map((value) => {
    if (typeof value !== 'object' || value === null) throw invalidTargets();
    const target = value as Record<string, unknown>;
    if (
      Object.keys(target).some((key) => !['homeId', 'incidentId', 'tenantId'].includes(key)) ||
      typeof target.homeId !== 'string' ||
      typeof target.incidentId !== 'string' ||
      typeof target.tenantId !== 'string'
    ) {
      throw invalidTargets();
    }
    return { homeId: target.homeId, incidentId: target.incidentId, tenantId: target.tenantId };
  });
}

function parseDeliveryResult(value: unknown): MissingFieldsDeliveryResult {
  if (typeof value !== 'object' || value === null) throw invalidDelivery();
  const result = value as Record<string, unknown>;
  const codes = [
    'already-reminded',
    'incident-not-found',
    'no-missing-fields',
    'provider-not-delivered',
    'reminder-already-recorded',
    'status-not-remindable',
  ];
  if (
    Object.keys(result).some((key) => !['dispatched', 'outcomeCode'].includes(key)) ||
    typeof result.dispatched !== 'boolean' ||
    (result.outcomeCode !== undefined &&
      (typeof result.outcomeCode !== 'string' || !codes.includes(result.outcomeCode)))
  ) {
    throw invalidDelivery();
  }
  const parsed: MissingFieldsDeliveryResult = {
    dispatched: result.dispatched,
    ...(result.outcomeCode === undefined
      ? {}
      : { outcomeCode: result.outcomeCode as MissingFieldsDeliveryResult['outcomeCode'] }),
  };
  assertDurablePayload(parsed, 'missingFieldsDeliveryResult');
  return parsed;
}

function invalidTargets(): Error {
  return new Error('Missing fields target lookup returned an invalid result.');
}

function invalidDelivery(): Error {
  return new Error('Missing fields delivery returned an invalid result.');
}
