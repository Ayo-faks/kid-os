import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import {
  type DurableHandoverResult,
  FINALIZE_HANDOVER_FAILURE_ACTIVITY,
  type FinalizeHandoverFailureInput,
  HANDOVER_ORCHESTRATION_VERSION,
  HANDOVER_ORCHESTRATOR,
  type HandoverOrchestratorInput,
  PROCESS_HANDOVER_COMMAND_ACTIVITY,
} from '../handover.contracts.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

const HANDOVER_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 1_000,
  maxNumberOfAttempts: 5,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* handoverOrchestrator(
  context: OrchestrationContext,
  input: HandoverOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableHandoverResult, unknown> {
  assertDurableInstanceId(context.instanceId);
  assertDurablePayload(input, 'handover');

  let result: DurableHandoverResult;
  try {
    const processed = yield context.callActivity<HandoverOrchestratorInput, DurableHandoverResult>(
      PROCESS_HANDOVER_COMMAND_ACTIVITY,
      input,
      { retry: HANDOVER_RETRY, version: HANDOVER_ORCHESTRATION_VERSION },
    );
    result = parseHandoverResult(processed, input.handoverId);
  } catch {
    result = failedResult(input.handoverId, 'processing-failed');
    yield context.callActivity<FinalizeHandoverFailureInput, void>(
      FINALIZE_HANDOVER_FAILURE_ACTIVITY,
      {
        actor: input.actor,
        commandId: input.commandId,
        handoverId: input.handoverId,
        homeId: input.homeId,
        outcomeCode: 'processing-failed',
        tenantId: input.tenantId,
      },
      { retry: HANDOVER_RETRY, version: HANDOVER_ORCHESTRATION_VERSION },
    );
  }

  context.setCustomStatus(result);
  if (result.status === 'failed') {
    throw new Error('Handover processing failed.');
  }
  return result;
}

export const HandoverOrchestrator = handoverOrchestrator as unknown as TOrchestrator;

export const HANDOVER_ORCHESTRATOR_NAME = HANDOVER_ORCHESTRATOR;

function parseHandoverResult(value: unknown, handoverId: string): DurableHandoverResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Handover activity returned an invalid result.');
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some(
      (key) =>
        !['handoverId', 'missingMandatory', 'outcomeCode', 'status', 'taskIds'].includes(key),
    ) ||
    result.handoverId !== handoverId ||
    (result.status !== 'completed' && result.status !== 'failed') ||
    !isStringArray(result.taskIds) ||
    !isStringArray(result.missingMandatory) ||
    (result.outcomeCode !== undefined &&
      result.outcomeCode !== 'processing-failed' &&
      result.outcomeCode !== 'validation-failed')
  ) {
    throw new Error('Handover activity returned an invalid result.');
  }
  const parsed: DurableHandoverResult = {
    handoverId,
    missingMandatory: result.missingMandatory,
    ...(result.outcomeCode === undefined ? {} : { outcomeCode: result.outcomeCode }),
    status: result.status,
    taskIds: result.taskIds,
  };
  assertDurablePayload(parsed, 'handoverResult');
  return parsed;
}

function failedResult(
  handoverId: string,
  outcomeCode: NonNullable<DurableHandoverResult['outcomeCode']>,
): DurableHandoverResult {
  return { handoverId, missingMandatory: [], outcomeCode, status: 'failed', taskIds: [] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
