// Phase 4 §5 (D5 follow-up) — real Docling document extraction.
//
// `loadDocumentForExtraction` reads the object_key/mime_type for a document
// under tenant context so the workflow doesn't need to hit Prisma directly.
// `extractDocument` streams the blob from MinIO and POSTs it to the
// `docling-serve` sidecar, returning the resulting Markdown. When
// `DOCLING_URL` isn't configured the activity short-circuits with an empty
// extraction and a `docling-disabled` reason so dev/test installs without a
// Docling daemon still complete the ingest workflow deterministically.

import type {
  ExtractDocumentInput,
  ExtractDocumentResult,
  LoadDocumentForExtractionInput,
  LoadDocumentForExtractionResult,
} from '@careos/contracts';

import { withTenantContext } from '../db/pg.js';
import { getObjectStorage } from '../storage/bundle-store.js';

const DEFAULT_DOCUMENTS_BUCKET = 'careos-documents';
const MAX_EXTRACTED_TEXT_BYTES = 1_000_000; // ~1MB safety cap before persistence.

interface DocumentLookupRow {
  readonly objectKey: string;
  readonly mimeType: string;
  readonly originalFilename: string;
}

export async function loadDocumentForExtraction(
  input: LoadDocumentForExtractionInput,
): Promise<LoadDocumentForExtractionResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<DocumentLookupRow>(
        `SELECT object_key AS "objectKey",
                mime_type AS "mimeType",
                original_filename AS "originalFilename"
           FROM core.documents
          WHERE id = $1::uuid
          LIMIT 1`,
        [input.documentId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`document ${input.documentId} not found`);
      }
      return row;
    },
  );
}

function isDoclingConfigured(): boolean {
  const url = process.env.DOCLING_URL ?? '';
  return url !== '' && url !== 'change-me';
}

function documentsBucket(): string {
  return (
    process.env.OBJECT_STORAGE_DOCUMENTS_CONTAINER ??
    process.env.MINIO_DOCUMENTS_BUCKET ??
    DEFAULT_DOCUMENTS_BUCKET
  );
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.from(chunk),
    );
  }
  return Buffer.concat(chunks);
}

interface DoclingConvertResponse {
  readonly document?: {
    readonly md_content?: string;
    readonly markdown?: string;
    readonly text_content?: string;
  };
}

export async function extractDocument(input: ExtractDocumentInput): Promise<ExtractDocumentResult> {
  if (!isDoclingConfigured()) {
    return { extractedText: '', reason: 'docling-disabled' };
  }

  const objectStorage = getObjectStorage();
  const blobStream = await objectStorage.getObject(documentsBucket(), input.objectKey);
  const blob = await streamToBuffer(blobStream);

  const form = new FormData();
  form.append('files', new Blob([blob], { type: input.mimeType }), input.originalFilename);
  // Ask docling-serve for inline markdown so we don't need a follow-up GET.
  form.append('to_formats', 'md');
  form.append('return_as_file', 'false');

  const endpoint = `${(process.env.DOCLING_URL ?? '').replace(/\/$/, '')}/v1/convert/file`;
  const response = await fetch(endpoint, { body: form, method: 'POST' });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`docling-serve ${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as DoclingConvertResponse;
  const text =
    payload.document?.md_content ??
    payload.document?.markdown ??
    payload.document?.text_content ??
    '';

  // Truncate before persistence so a runaway OCR doesn't blow the row size.
  const truncated =
    Buffer.byteLength(text, 'utf8') > MAX_EXTRACTED_TEXT_BYTES
      ? Buffer.from(text, 'utf8').subarray(0, MAX_EXTRACTED_TEXT_BYTES).toString('utf8')
      : text;

  return { extractedText: truncated };
}
