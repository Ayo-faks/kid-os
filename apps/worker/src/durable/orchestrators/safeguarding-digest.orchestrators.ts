import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
  whenAll,
} from '@microsoft/durabletask-js';

import { assertDurablePayload } from '../payload-policy.js';
import {
  CALCULATE_NEXT_SAFEGUARDING_DIGEST_FIRE_ACTIVITY,
  type CalculateNextSafeguardingDigestFireInput,
  FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY,
  PROCESS_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
  SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
  type SafeguardingDigestDeliveryInput,
  type SafeguardingDigestDeliveryResult,
  type SafeguardingDigestScheduleInput,
  type SafeguardingDigestSweepInput,
  START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
  START_SAFEGUARDING_DIGEST_SWEEP_ACTIVITY,
  type StartSafeguardingDigestDeliveryInput,
  type StartSafeguardingDigestSweepInput,
  safeguardingDigestDeliveryInstanceId,
  safeguardingDigestSweepInstanceId,
} from '../safeguarding-digest.contracts.js';

const RETRY = new RetryPolicy({ firstRetryIntervalInMilliseconds: 2_000, maxNumberOfAttempts: 3 });

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* safeguardingDigestScheduleOrchestrator(
  context: OrchestrationContext,
  input: SafeguardingDigestScheduleInput = {},
): AsyncGenerator<Task<unknown>, void, unknown> {
  assertDurablePayload(input, 'safeguardingDigestSchedule');
  const windowMinutes = input.windowMinutes ?? 10_080;
  const next = yield context.callActivity<CalculateNextSafeguardingDigestFireInput, string>(
    CALCULATE_NEXT_SAFEGUARDING_DIGEST_FIRE_ACTIVITY,
    {
      afterIso: context.currentUtcDateTime.toISOString(),
      ...(input.intervalSeconds === undefined ? {} : { intervalSeconds: input.intervalSeconds }),
    },
    { retry: RETRY, version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION },
  );
  if (typeof next !== 'string') throw new Error('Safeguarding digest next fire result is invalid.');
  context.setCustomStatus({ kind: 'safeguarding-digest-schedule', nextFireAtIso: next });
  yield context.createTimer(new Date(next));
  const sweepInstanceId = safeguardingDigestSweepInstanceId(next);
  yield context.callActivity<StartSafeguardingDigestSweepInput, string>(
    START_SAFEGUARDING_DIGEST_SWEEP_ACTIVITY,
    {
      correlationId: sweepInstanceId,
      nowIso: next,
      sinceIso: new Date(new Date(next).getTime() - windowMinutes * 60_000).toISOString(),
      sweepInstanceId,
    },
    { retry: RETRY, version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION },
  );
  context.continueAsNew(input, false);
}

export const SafeguardingDigestScheduleOrchestrator =
  safeguardingDigestScheduleOrchestrator as unknown as TOrchestrator;

interface DigestTarget {
  readonly homeId: string;
  readonly tenantId: string;
}

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* safeguardingDigestSweepOrchestrator(
  context: OrchestrationContext,
  input: SafeguardingDigestSweepInput,
): AsyncGenerator<
  Task<unknown>,
  { readonly deliveryInstanceIds: readonly string[]; readonly scanned: number },
  unknown
> {
  assertDurablePayload(input, 'safeguardingDigestSweep');
  const found = yield context.callActivity<{ readonly correlationId: string }, unknown>(
    FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY,
    { correlationId: input.correlationId },
    { retry: RETRY, version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION },
  );
  const targets = parseTargets(found);
  const starts = targets.map((target) => {
    const deliveryInstanceId = safeguardingDigestDeliveryInstanceId(target.homeId, input.nowIso);
    return context.callActivity<StartSafeguardingDigestDeliveryInput, string>(
      START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
      {
        ...target,
        correlationId: `${input.correlationId}:${target.homeId}`,
        deliveryInstanceId,
        nowIso: input.nowIso,
        sinceIso: input.sinceIso,
      },
      { retry: RETRY, version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION },
    );
  });
  const started = starts.length === 0 ? [] : yield whenAll(starts);
  if (!Array.isArray(started) || !started.every((value) => typeof value === 'string')) {
    throw new Error('Safeguarding digest delivery starts returned an invalid result.');
  }
  return { deliveryInstanceIds: started, scanned: targets.length };
}

export const SafeguardingDigestSweepOrchestrator =
  safeguardingDigestSweepOrchestrator as unknown as TOrchestrator;

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* sendSafeguardingDigestOrchestrator(
  context: OrchestrationContext,
  input: SafeguardingDigestDeliveryInput,
): AsyncGenerator<Task<unknown>, SafeguardingDigestDeliveryResult, unknown> {
  assertDurablePayload(input, 'safeguardingDigestDelivery');
  const result = yield context.callActivity<
    SafeguardingDigestDeliveryInput,
    SafeguardingDigestDeliveryResult
  >(PROCESS_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY, input, {
    retry: RETRY,
    version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
  });
  return parseDeliveryResult(result);
}

export const SendSafeguardingDigestOrchestrator =
  sendSafeguardingDigestOrchestrator as unknown as TOrchestrator;

function parseTargets(value: unknown): readonly DigestTarget[] {
  if (typeof value !== 'object' || value === null) throw invalidTargets();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => key !== 'targets') || !Array.isArray(result.targets)) {
    throw invalidTargets();
  }
  return result.targets.map((value) => {
    if (typeof value !== 'object' || value === null) throw invalidTargets();
    const target = value as Record<string, unknown>;
    if (
      Object.keys(target).some((key) => !['homeId', 'tenantId'].includes(key)) ||
      typeof target.homeId !== 'string' ||
      typeof target.tenantId !== 'string'
    ) {
      throw invalidTargets();
    }
    return { homeId: target.homeId, tenantId: target.tenantId };
  });
}

function parseDeliveryResult(value: unknown): SafeguardingDigestDeliveryResult {
  if (typeof value !== 'object' || value === null) throw invalidDelivery();
  const result = value as Record<string, unknown>;
  const codes = ['already-recorded', 'audit-not-recorded', 'provider-not-delivered'];
  if (
    Object.keys(result).some((key) => !['dispatched', 'outcomeCode'].includes(key)) ||
    typeof result.dispatched !== 'boolean' ||
    (result.outcomeCode !== undefined &&
      (typeof result.outcomeCode !== 'string' || !codes.includes(result.outcomeCode)))
  ) {
    throw invalidDelivery();
  }
  const parsed: SafeguardingDigestDeliveryResult = {
    dispatched: result.dispatched,
    ...(result.outcomeCode === undefined
      ? {}
      : { outcomeCode: result.outcomeCode as SafeguardingDigestDeliveryResult['outcomeCode'] }),
  };
  assertDurablePayload(parsed, 'safeguardingDigestDeliveryResult');
  return parsed;
}

function invalidTargets(): Error {
  return new Error('Safeguarding digest target lookup returned an invalid result.');
}

function invalidDelivery(): Error {
  return new Error('Safeguarding digest delivery returned an invalid result.');
}
