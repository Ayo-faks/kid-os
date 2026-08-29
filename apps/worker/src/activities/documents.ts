// Phase 3 §5 (D5) — Document ingestion activities.
//
// The real OCR/Docling pipeline lands in Phase 4. For now `markDocumentExtracting`
// flips uploaded → extracting and `markDocumentExtracted` flips extracting →
// extracted, both as race-safe conditional UPDATEs so workflow retries are idempotent.

import type {
  DocumentStatus,
  MarkDocumentExtractedInput,
  MarkDocumentExtractedResult,
  MarkDocumentExtractingInput,
  MarkDocumentExtractingResult,
  MarkDocumentFailedInput,
  MarkDocumentFailedResult,
} from '@careos/contracts';

import { withTenantContext } from '../db/pg.js';

interface StatusRow {
  readonly status: DocumentStatus;
}

async function readStatus(
  client: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
  documentId: string,
): Promise<DocumentStatus | null> {
  const result = await client.query<StatusRow>(
    `SELECT status FROM core.documents WHERE id = $1::uuid LIMIT 1`,
    [documentId],
  );
  return result.rows[0]?.status ?? null;
}

export async function markDocumentExtracting(
  input: MarkDocumentExtractingInput,
): Promise<MarkDocumentExtractingResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query(
        `UPDATE core.documents
            SET status = 'extracting',
                updated_at = NOW()
          WHERE id = $1::uuid
            AND status = 'uploaded'`,
        [input.documentId],
      );
      const transitioned = (result.rowCount ?? 0) > 0;
      const status = (await readStatus(client, input.documentId)) ?? 'uploaded';
      return { status, transitioned };
    },
  );
}

export async function markDocumentExtracted(
  input: MarkDocumentExtractedInput,
): Promise<MarkDocumentExtractedResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query(
        `UPDATE core.documents
            SET status = 'extracted',
                extracted_text = $2,
                updated_at = NOW()
          WHERE id = $1::uuid
            AND status = 'extracting'`,
        [input.documentId, input.extractedText],
      );
      const transitioned = (result.rowCount ?? 0) > 0;
      const status = (await readStatus(client, input.documentId)) ?? 'uploaded';
      return { status, transitioned };
    },
  );
}

export async function markDocumentFailed(
  input: MarkDocumentFailedInput,
): Promise<MarkDocumentFailedResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query(
        `UPDATE core.documents
            SET status = 'failed',
                failure_reason = $2,
                updated_at = NOW()
          WHERE id = $1::uuid
            AND status IN ('uploaded', 'extracting')`,
        [input.documentId, input.failureReason],
      );
      const transitioned = (result.rowCount ?? 0) > 0;
      const status = (await readStatus(client, input.documentId)) ?? 'uploaded';
      return { status, transitioned };
    },
  );
}
