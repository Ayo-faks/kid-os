import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import { assertDurablePayload } from '../payload-policy.js';
import {
  CALCULATE_NEXT_RETENTION_FIRE_ACTIVITY,
  type CalculateNextRetentionFireInput,
  type DurableRetentionSweepResult,
  FINALIZE_RETENTION_SWEEP_FAILURE_ACTIVITY,
  PROCESS_RETENTION_SWEEP_ACTIVITY,
  RETENTION_ORCHESTRATION_VERSION,
  type RetentionScheduleInput,
  type RetentionSweepOrchestratorInput,
  START_RETENTION_SWEEP_ACTIVITY,
  type StartRetentionSweepInput,
  retentionSweepInstanceId,
} from '../retention.contracts.js';

const RETENTION_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 5_000,
  maxNumberOfAttempts: 3,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* retentionSweepOrchestrator(
  context: OrchestrationContext,
  input: RetentionSweepOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableRetentionSweepResult, unknown> {
  assertDurablePayload(input, 'retentionSweep');
  try {
    const processed = yield context.callActivity<
      RetentionSweepOrchestratorInput,
      DurableRetentionSweepResult
    >(PROCESS_RETENTION_SWEEP_ACTIVITY, input, {
      retry: RETENTION_RETRY,
      version: RETENTION_ORCHESTRATION_VERSION,
    });
    const result = parseSweepResult(processed, input.sweepId);
    context.setCustomStatus(result);
    return result;
  } catch {
    yield context.callActivity<RetentionSweepOrchestratorInput, void>(
      FINALIZE_RETENTION_SWEEP_FAILURE_ACTIVITY,
      input,
      { retry: RETENTION_RETRY, version: RETENTION_ORCHESTRATION_VERSION },
    );
    throw new Error('Retention sweep failed.');
  }
}

export const RetentionSweepOrchestrator = retentionSweepOrchestrator as unknown as TOrchestrator;

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* retentionScheduleOrchestrator(
  context: OrchestrationContext,
  input: RetentionScheduleInput = {},
): AsyncGenerator<Task<unknown>, void, unknown> {
  assertDurablePayload(input, 'retentionSchedule');
  const hourLocal = input.hourLocal ?? 2;
  const timeZone = input.timeZone ?? 'Europe/London';
  if (hourLocal !== 2 || timeZone !== 'Europe/London') {
    throw new Error('Retention schedule only supports 02:00 Europe/London.');
  }
  const nextFireResult = yield context.callActivity<CalculateNextRetentionFireInput, string>(
    CALCULATE_NEXT_RETENTION_FIRE_ACTIVITY,
    { afterIso: context.currentUtcDateTime.toISOString(), hourLocal, timeZone },
    { retry: RETENTION_RETRY, version: RETENTION_ORCHESTRATION_VERSION },
  );
  if (typeof nextFireResult !== 'string') {
    throw new Error('calculateNextRetentionFireActivityV1 returned an invalid result.');
  }

  context.setCustomStatus({
    kind: 'retention-schedule',
    nextFireAtIso: nextFireResult,
    version: context.version || RETENTION_ORCHESTRATION_VERSION,
  });
  yield context.createTimer(new Date(nextFireResult));

  const sweepId = nextFireResult;
  const sweepInstanceId = retentionSweepInstanceId(sweepId);
  yield context.callActivity<StartRetentionSweepInput, string>(
    START_RETENTION_SWEEP_ACTIVITY,
    {
      correlationId: sweepInstanceId,
      nowIso: nextFireResult,
      sweepId,
      sweepInstanceId,
    },
    { retry: RETENTION_RETRY, version: RETENTION_ORCHESTRATION_VERSION },
  );
  context.continueAsNew(input, false);
}

export const RetentionScheduleOrchestrator =
  retentionScheduleOrchestrator as unknown as TOrchestrator;

function parseSweepResult(value: unknown, sweepId: string): DurableRetentionSweepResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Retention sweep activity returned an invalid result.');
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some(
      (key) => !['policiesApplied', 'sweepId', 'totalAffected', 'totalScanned'].includes(key),
    ) ||
    result.sweepId !== sweepId ||
    !isNonNegativeInteger(result.policiesApplied) ||
    !isNonNegativeInteger(result.totalAffected) ||
    !isNonNegativeInteger(result.totalScanned)
  ) {
    throw new Error('Retention sweep activity returned an invalid result.');
  }
  const parsed = {
    policiesApplied: result.policiesApplied,
    sweepId,
    totalAffected: result.totalAffected,
    totalScanned: result.totalScanned,
  };
  assertDurablePayload(parsed, 'retentionSweepResult');
  return parsed;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
