import type { DocIngestWorkflowInput } from '@careos/contracts';
import {
  DOCUMENT_INGEST_DURABLE_VERSION,
  DOCUMENT_INGEST_DURABLE_WORKFLOW_TYPE,
  documentIngestWorkflowId,
} from '@careos/contracts';

import { assertDurableInstanceId } from './payload-policy.js';

export const DOCUMENT_INGEST_ORCHESTRATION_VERSION = DOCUMENT_INGEST_DURABLE_VERSION;
export const DOCUMENT_INGEST_ORCHESTRATOR = DOCUMENT_INGEST_DURABLE_WORKFLOW_TYPE;
export const PROCESS_DOCUMENT_INGEST_ACTIVITY = 'processDocumentIngestActivityV1';

export type DocumentIngestOrchestratorInput = DocIngestWorkflowInput;

export interface DurableDocumentIngestResult {
  readonly documentId: string;
  readonly outcomeCode?: 'docling-unavailable' | 'extraction-failed';
  readonly status: 'extracted' | 'failed';
}

export function documentIngestInstanceId(documentId: string): string {
  return assertDurableInstanceId(documentIngestWorkflowId(documentId));
}
