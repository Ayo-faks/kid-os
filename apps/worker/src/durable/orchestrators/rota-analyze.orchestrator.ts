import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';
import {
  type DurableRotaAnalyzeResult,
  FINALIZE_ROTA_ANALYZE_FAILURE_ACTIVITY,
  type FinalizeRotaAnalyzeFailureInput,
  PROCESS_ROTA_ANALYZE_COMMAND_ACTIVITY,
  ROTA_ANALYZE_ORCHESTRATION_VERSION,
  ROTA_ANALYZE_ORCHESTRATOR,
  type RotaAnalyzeOrchestratorInput,
} from '../rota-analyze.contracts.js';

const ROTA_ANALYZE_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 1_000,
  maxNumberOfAttempts: 3,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* rotaAnalyzeOrchestrator(
  context: OrchestrationContext,
  input: RotaAnalyzeOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableRotaAnalyzeResult, unknown> {
  assertDurableInstanceId(context.instanceId);
  assertDurablePayload(input, 'rotaAnalyze');

  let result: DurableRotaAnalyzeResult;
  try {
    const processed = yield context.callActivity<
      RotaAnalyzeOrchestratorInput,
      DurableRotaAnalyzeResult
    >(PROCESS_ROTA_ANALYZE_COMMAND_ACTIVITY, input, {
      retry: ROTA_ANALYZE_RETRY,
      version: ROTA_ANALYZE_ORCHESTRATION_VERSION,
    });
    result = parseRotaAnalyzeResult(processed, input.analysisId);
  } catch {
    result = failedResult(input.analysisId);
    yield context.callActivity<FinalizeRotaAnalyzeFailureInput, void>(
      FINALIZE_ROTA_ANALYZE_FAILURE_ACTIVITY,
      {
        actor: input.actor,
        analysisId: input.analysisId,
        commandId: input.commandId,
        homeId: input.homeId,
        tenantId: input.tenantId,
      },
      { retry: ROTA_ANALYZE_RETRY, version: ROTA_ANALYZE_ORCHESTRATION_VERSION },
    );
  }

  context.setCustomStatus(result);
  if (result.status === 'failed') {
    throw new Error('Rota analysis failed.');
  }
  return result;
}

export const RotaAnalyzeOrchestrator = rotaAnalyzeOrchestrator as unknown as TOrchestrator;

export const ROTA_ANALYZE_ORCHESTRATOR_NAME = ROTA_ANALYZE_ORCHESTRATOR;

function parseRotaAnalyzeResult(value: unknown, analysisId: string): DurableRotaAnalyzeResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Rota analysis activity returned an invalid result.');
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !['analysisId', 'outcomeCode', 'status'].includes(key)) ||
    result.analysisId !== analysisId ||
    (result.status !== 'completed' && result.status !== 'failed') ||
    (result.outcomeCode !== undefined && result.outcomeCode !== 'processing-failed')
  ) {
    throw new Error('Rota analysis activity returned an invalid result.');
  }
  const parsed: DurableRotaAnalyzeResult = {
    analysisId,
    ...(result.outcomeCode === undefined ? {} : { outcomeCode: result.outcomeCode }),
    status: result.status,
  };
  assertDurablePayload(parsed, 'rotaAnalyzeResult');
  return parsed;
}

function failedResult(analysisId: string): DurableRotaAnalyzeResult {
  return { analysisId, outcomeCode: 'processing-failed', status: 'failed' };
}
