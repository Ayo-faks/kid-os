import type { ActivityContext } from '@microsoft/durabletask-js';

import { extractDocument, loadDocumentForExtraction } from '../../activities/documents-extract.js';
import {
  markDocumentExtracted,
  markDocumentExtracting,
  markDocumentFailed,
} from '../../activities/documents.js';
import { withTenantContext } from '../../db/pg.js';
import type {
  DocumentIngestOrchestratorInput,
  DurableDocumentIngestResult,
} from '../document-ingest.contracts.js';

export async function processDocumentIngestActivity(
  _context: ActivityContext,
  input: DocumentIngestOrchestratorInput,
): Promise<DurableDocumentIngestResult> {
  let outcome: DurableDocumentIngestResult;
  try {
    const extracting = await markDocumentExtracting({
      actor: input.actor,
      documentId: input.documentId,
      homeId: input.homeId,
      tenantId: input.tenantId,
    });

    if (extracting.status === 'extracted') {
      outcome = { documentId: input.documentId, status: 'extracted' };
    } else if (extracting.status === 'failed') {
      outcome = {
        documentId: input.documentId,
        outcomeCode: 'extraction-failed',
        status: 'failed',
      };
    } else if (extracting.status !== 'extracting') {
      outcome = await recordFailure(input, 'document-ingest-invalid-state', 'extraction-failed');
    } else {
      outcome = await extractAndPersist(input);
    }
  } catch (error) {
    try {
      outcome = await recordFailure(input, deepestErrorMessage(error), 'extraction-failed');
    } catch {
      throw new Error('Document ingest failed before a safe outcome was persisted.');
    }
  }

  try {
    await markWorkflowOwner(input, outcome.status === 'extracted' ? 'completed' : 'failed');
  } catch {
    throw new Error('Document ingest outcome was persisted but ownership reconciliation failed.');
  }
  return outcome;
}

async function extractAndPersist(
  input: DocumentIngestOrchestratorInput,
): Promise<DurableDocumentIngestResult> {
  const loaded = await loadDocumentForExtraction({
    actor: input.actor,
    documentId: input.documentId,
    homeId: input.homeId,
    tenantId: input.tenantId,
  });
  const extraction = await extractDocument({
    actor: input.actor,
    documentId: input.documentId,
    homeId: input.homeId,
    mimeType: loaded.mimeType,
    objectKey: loaded.objectKey,
    originalFilename: loaded.originalFilename,
    tenantId: input.tenantId,
  });

  if (extraction.reason !== undefined) {
    const failureCode =
      extraction.reason === 'docling-disabled' ? 'docling-unavailable' : 'extraction-failed';
    const failureDetail =
      extraction.reason === 'docling-disabled' ? 'docling-unavailable' : extraction.reason;
    return recordFailure(input, failureDetail, failureCode);
  }

  const extracted = await markDocumentExtracted({
    actor: input.actor,
    documentId: input.documentId,
    extractedText: extraction.extractedText,
    homeId: input.homeId,
    tenantId: input.tenantId,
  });
  if (extracted.status !== 'extracted') {
    throw new Error('document-ingest-extracted-state-not-persisted');
  }
  return { documentId: input.documentId, status: 'extracted' };
}

async function recordFailure(
  input: DocumentIngestOrchestratorInput,
  failureDetail: string,
  outcomeCode: NonNullable<DurableDocumentIngestResult['outcomeCode']>,
): Promise<DurableDocumentIngestResult> {
  const failed = await markDocumentFailed({
    actor: input.actor,
    documentId: input.documentId,
    failureReason: failureDetail.slice(0, 500),
    homeId: input.homeId,
    tenantId: input.tenantId,
  });
  if (failed.status === 'extracted') {
    return { documentId: input.documentId, status: 'extracted' };
  }
  if (failed.status !== 'failed') {
    throw new Error('document-ingest-failed-state-not-persisted');
  }
  return { documentId: input.documentId, outcomeCode, status: 'failed' };
}

async function markWorkflowOwner(
  input: DocumentIngestOrchestratorInput,
  status: 'completed' | 'failed',
): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_instances
            SET status = $2, updated_at = now()
          WHERE workflow_kind = 'document'
            AND subject_type = 'document'
            AND subject_id = $1::uuid
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"`,
        [input.documentId, status],
      );
    },
  );
}

function deepestErrorMessage(error: unknown): string {
  let current = error;
  let message = 'doc-ingest-unknown-error';
  while (current instanceof Error) {
    if (current.message !== '') message = current.message;
    current = current.cause;
  }
  return message;
}
