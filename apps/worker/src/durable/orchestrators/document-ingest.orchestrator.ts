import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import {
  DOCUMENT_INGEST_ORCHESTRATION_VERSION,
  DOCUMENT_INGEST_ORCHESTRATOR,
  type DocumentIngestOrchestratorInput,
  type DurableDocumentIngestResult,
  PROCESS_DOCUMENT_INGEST_ACTIVITY,
} from '../document-ingest.contracts.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

const DOCUMENT_INGEST_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 2_000,
  maxNumberOfAttempts: 3,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* documentIngestOrchestrator(
  context: OrchestrationContext,
  input: DocumentIngestOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableDocumentIngestResult, unknown> {
  assertDurableInstanceId(context.instanceId);
  assertDurablePayload(input, 'documentIngest');

  const processed = yield context.callActivity<
    DocumentIngestOrchestratorInput,
    DurableDocumentIngestResult
  >(PROCESS_DOCUMENT_INGEST_ACTIVITY, input, {
    retry: DOCUMENT_INGEST_RETRY,
    version: DOCUMENT_INGEST_ORCHESTRATION_VERSION,
  });
  const result = parseDocumentIngestResult(processed, input.documentId);
  context.setCustomStatus(result);
  return result;
}

export const DocumentIngestOrchestrator = documentIngestOrchestrator as unknown as TOrchestrator;

export const DOCUMENT_INGEST_ORCHESTRATOR_NAME = DOCUMENT_INGEST_ORCHESTRATOR;

function parseDocumentIngestResult(
  value: unknown,
  documentId: string,
): DurableDocumentIngestResult {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Document ingest activity returned an invalid result.');
  }
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !['documentId', 'outcomeCode', 'status'].includes(key)) ||
    result.documentId !== documentId ||
    (result.status !== 'extracted' && result.status !== 'failed') ||
    (result.outcomeCode !== undefined &&
      result.outcomeCode !== 'docling-unavailable' &&
      result.outcomeCode !== 'extraction-failed')
  ) {
    throw new Error('Document ingest activity returned an invalid result.');
  }
  const parsed: DurableDocumentIngestResult = {
    documentId,
    ...(result.outcomeCode === undefined ? {} : { outcomeCode: result.outcomeCode }),
    status: result.status,
  };
  assertDurablePayload(parsed, 'documentIngestResult');
  return parsed;
}
