// Phase 4 §5 (D5 follow-up) — real Docling document ingestion workflow.
//
// `DocIngestWorkflow` transitions uploaded → extracting → extracted, calling
// Docling between the state flips so the extracted Markdown is persisted on
// the row. Activities are race-safe conditional UPDATEs so workflow retries
// are idempotent.

import type { DocIngestWorkflowInput, DocumentStatus } from '@careos/contracts/workflow';
import { proxyActivities } from '@temporalio/workflow';

import type * as documentsExtractActivities from '../activities/documents-extract.js';
import type * as documentsActivities from '../activities/documents.js';

const { markDocumentExtracted, markDocumentExtracting, markDocumentFailed } = proxyActivities<
  typeof documentsActivities
>({
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
  startToCloseTimeout: '30 seconds',
});

const { extractDocument, loadDocumentForExtraction } = proxyActivities<
  typeof documentsExtractActivities
>({
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
  // Docling can take a while on large PDFs / image OCR.
  startToCloseTimeout: '10 minutes',
});

export interface DocIngestWorkflowResult {
  readonly status: DocumentStatus;
}

export async function DocIngestWorkflow(
  input: DocIngestWorkflowInput,
): Promise<DocIngestWorkflowResult> {
  try {
    const extracting = await markDocumentExtracting({
      actor: input.actor,
      documentId: input.documentId,
      homeId: input.homeId,
      tenantId: input.tenantId,
    });

    if (extracting.status !== 'extracting') {
      // Either already past extracting (idempotent retry) or terminally failed.
      return { status: extracting.status };
    }

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
      const failureReason =
        extraction.reason === 'docling-disabled' ? 'docling-unavailable' : extraction.reason;
      const failed = await markDocumentFailed({
        actor: input.actor,
        documentId: input.documentId,
        failureReason,
        homeId: input.homeId,
        tenantId: input.tenantId,
      });
      return { status: failed.status };
    }

    const extracted = await markDocumentExtracted({
      actor: input.actor,
      documentId: input.documentId,
      extractedText: extraction.extractedText,
      homeId: input.homeId,
      tenantId: input.tenantId,
    });

    return { status: extracted.status };
  } catch (error) {
    const reason = deepestErrorMessage(error);
    const failed = await markDocumentFailed({
      actor: input.actor,
      documentId: input.documentId,
      failureReason: reason.slice(0, 500),
      homeId: input.homeId,
      tenantId: input.tenantId,
    });
    return { status: failed.status };
  }
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
