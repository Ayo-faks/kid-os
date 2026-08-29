import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import {
  type DurableExportBundleResult,
  EXPORT_BUNDLE_ORCHESTRATION_VERSION,
  PROCESS_EXPORT_BUNDLE_ACTIVITY,
  SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR,
  type SeriousIncidentExportOrchestratorInput,
} from '../export-bundle.contracts.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

const EXPORT_BUNDLE_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 2_000,
  maxNumberOfAttempts: 3,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* seriousIncidentExportOrchestrator(
  context: OrchestrationContext,
  input: SeriousIncidentExportOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableExportBundleResult, unknown> {
  assertDurableInstanceId(context.instanceId);
  assertDurablePayload(input, 'seriousIncidentExport');

  const processed = yield context.callActivity<
    SeriousIncidentExportOrchestratorInput,
    DurableExportBundleResult
  >(PROCESS_EXPORT_BUNDLE_ACTIVITY, input, {
    retry: EXPORT_BUNDLE_RETRY,
    version: EXPORT_BUNDLE_ORCHESTRATION_VERSION,
  });
  const result = parseExportBundleResult(processed, input.bundleId);
  context.setCustomStatus(result);
  return result;
}

export const SeriousIncidentExportOrchestrator =
  seriousIncidentExportOrchestrator as unknown as TOrchestrator;

export const SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR_NAME = SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR;

function parseExportBundleResult(value: unknown, bundleId: string): DurableExportBundleResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Export bundle activity returned an invalid result.');
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !['bundleId', 'outcomeCode', 'status'].includes(key)) ||
    result.bundleId !== bundleId ||
    (result.status !== 'ready' && result.status !== 'failed') ||
    (result.outcomeCode !== undefined && result.outcomeCode !== 'bundle-build-failed')
  ) {
    throw new Error('Export bundle activity returned an invalid result.');
  }
  const parsed: DurableExportBundleResult = {
    bundleId,
    ...(result.outcomeCode === undefined ? {} : { outcomeCode: result.outcomeCode }),
    status: result.status,
  };
  assertDurablePayload(parsed, 'exportBundleResult');
  return parsed;
}
