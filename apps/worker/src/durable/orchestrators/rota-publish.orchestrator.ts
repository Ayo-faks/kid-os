import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';
import {
  type DurableRotaPublishResult,
  FINALIZE_ROTA_PUBLISH_FAILURE_ACTIVITY,
  type FinalizeRotaPublishFailureInput,
  PROCESS_ROTA_PUBLISH_COMMAND_ACTIVITY,
  ROTA_PUBLISH_ORCHESTRATION_VERSION,
  ROTA_PUBLISH_ORCHESTRATOR,
  type RotaPublishOrchestratorInput,
} from '../rota-publish.contracts.js';

const ROTA_PUBLISH_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 1_000,
  maxNumberOfAttempts: 5,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* rotaPublishOrchestrator(
  context: OrchestrationContext,
  input: RotaPublishOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableRotaPublishResult, unknown> {
  assertDurableInstanceId(context.instanceId);
  assertDurablePayload(input, 'rotaPublish');

  let result: DurableRotaPublishResult;
  try {
    const processed = yield context.callActivity<
      RotaPublishOrchestratorInput,
      DurableRotaPublishResult
    >(PROCESS_ROTA_PUBLISH_COMMAND_ACTIVITY, input, {
      retry: ROTA_PUBLISH_RETRY,
      version: ROTA_PUBLISH_ORCHESTRATION_VERSION,
    });
    result = parseRotaPublishResult(processed, input.publicationId);
  } catch {
    result = failedResult(input.publicationId);
    yield context.callActivity<FinalizeRotaPublishFailureInput, void>(
      FINALIZE_ROTA_PUBLISH_FAILURE_ACTIVITY,
      {
        actor: input.actor,
        commandId: input.commandId,
        homeId: input.homeId,
        publicationId: input.publicationId,
        tenantId: input.tenantId,
      },
      { retry: ROTA_PUBLISH_RETRY, version: ROTA_PUBLISH_ORCHESTRATION_VERSION },
    );
  }

  context.setCustomStatus(result);
  if (result.status === 'failed') {
    throw new Error('Rota publication failed.');
  }
  return result;
}

export const RotaPublishOrchestrator = rotaPublishOrchestrator as unknown as TOrchestrator;

export const ROTA_PUBLISH_ORCHESTRATOR_NAME = ROTA_PUBLISH_ORCHESTRATOR;

function parseRotaPublishResult(value: unknown, publicationId: string): DurableRotaPublishResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Rota publish activity returned an invalid result.');
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some(
      (key) => !['outcomeCode', 'publicationId', 'publishedAssignmentIds', 'status'].includes(key),
    ) ||
    result.publicationId !== publicationId ||
    (result.status !== 'published' && result.status !== 'failed') ||
    !Array.isArray(result.publishedAssignmentIds) ||
    !result.publishedAssignmentIds.every((id) => typeof id === 'string') ||
    (result.outcomeCode !== undefined && result.outcomeCode !== 'processing-failed')
  ) {
    throw new Error('Rota publish activity returned an invalid result.');
  }
  const parsed: DurableRotaPublishResult = {
    ...(result.outcomeCode === undefined ? {} : { outcomeCode: result.outcomeCode }),
    publicationId,
    publishedAssignmentIds: result.publishedAssignmentIds,
    status: result.status,
  };
  assertDurablePayload(parsed, 'rotaPublishResult');
  return parsed;
}

function failedResult(publicationId: string): DurableRotaPublishResult {
  return {
    outcomeCode: 'processing-failed',
    publicationId,
    publishedAssignmentIds: [],
    status: 'failed',
  };
}
