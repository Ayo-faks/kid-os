// Phase 3 §5 (D5) — Document ingestion activity + workflow contracts.
// Real OCR/extraction is deferred to Phase 4; this slice provides the
// status-transition contract used by the stub `DocIngestWorkflow`.

import type { IncidentActor } from './incidents-workflow.js';

export type DocumentStatus = 'uploaded' | 'extracting' | 'extracted' | 'failed';

export const DOCUMENT_INGEST_DURABLE_WORKFLOW_TYPE = 'DocumentIngestOrchestratorV1';
export const DOCUMENT_INGEST_DURABLE_VERSION = '1.0.0';

export interface DocIngestWorkflowInput {
  readonly documentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly actor: IncidentActor;
}

export interface MarkDocumentExtractingInput {
  readonly documentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly actor: IncidentActor;
}

export interface MarkDocumentExtractingResult {
  readonly transitioned: boolean;
  readonly status: DocumentStatus;
}

export interface MarkDocumentExtractedInput {
  readonly documentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly extractedText: string;
  readonly actor: IncidentActor;
}

export interface MarkDocumentExtractedResult {
  readonly transitioned: boolean;
  readonly status: DocumentStatus;
}

export interface MarkDocumentFailedInput {
  readonly documentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly failureReason: string;
  readonly actor: IncidentActor;
}

export interface MarkDocumentFailedResult {
  readonly transitioned: boolean;
  readonly status: DocumentStatus;
}

export const DOCUMENTS_TASK_QUEUE = 'careos.documents' as const;

export function documentIngestWorkflowId(documentId: string): string {
  return `doc-ingest-${documentId}`;
}

// --- Phase 4 §5 follow-up: real Docling extraction --------------------------

export interface LoadDocumentForExtractionInput {
  readonly documentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly actor: IncidentActor;
}

export interface LoadDocumentForExtractionResult {
  readonly objectKey: string;
  readonly mimeType: string;
  readonly originalFilename: string;
}

export interface ExtractDocumentInput {
  readonly documentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly objectKey: string;
  readonly mimeType: string;
  readonly originalFilename: string;
  readonly actor: IncidentActor;
}

export interface ExtractDocumentResult {
  readonly extractedText: string;
  /**
   * Reason for an empty extraction when the activity short-circuited
   * (e.g. `docling-disabled`); undefined on a successful Docling round-trip.
   */
  readonly reason?: string;
}
