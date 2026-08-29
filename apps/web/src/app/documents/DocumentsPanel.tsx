'use client';

import { Upload } from 'lucide-react';
import { useRef, useState, type FormEvent, type JSX } from 'react';

export type DocumentStatus = 'uploaded' | 'extracting' | 'extracted' | 'failed';

export interface DocumentView {
  readonly createdAt: string;
  readonly failureReason: string | null;
  readonly id: string;
  readonly mimeType: string;
  readonly objectKey: string;
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly status: DocumentStatus;
  readonly updatedAt: string;
}

interface DocumentsResponse {
  readonly documents: readonly DocumentView[];
}

interface PresignResponse {
  readonly objectKey: string;
  readonly uploadUrl: string;
}

const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024;
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain',
};
const SUPPORTED_MIME_TYPES = new Set(Object.values(MIME_BY_EXTENSION));

export function DocumentsPanel({
  initialDocuments,
  listUnavailable,
}: {
  readonly initialDocuments: readonly DocumentView[];
  readonly listUnavailable: boolean;
}): JSX.Element {
  const [documents, setDocuments] = useState(initialDocuments);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);

  async function refreshDocuments(): Promise<void> {
    const response = await fetch('/api/documents', { cache: 'no-store' });
    const payload = (await response.json()) as Partial<DocumentsResponse>;
    if (!response.ok || payload.documents === undefined) {
      throw new Error(`Unable to refresh documents (HTTP ${response.status}).`);
    }
    setDocuments(payload.documents);
  }

  async function upload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (uploadingRef.current) return;

    setError(null);
    setStatus(null);
    if (file === null) {
      setError('Choose a document to upload.');
      return;
    }
    const mimeType = documentMimeType(file);
    if (mimeType === null) {
      setError('Choose a PDF, Word, PNG, JPEG, text, or Markdown document.');
      return;
    }
    if (file.size === 0 || file.size > MAX_DOCUMENT_SIZE_BYTES) {
      setError('Document size must be between 1 byte and 25 MB.');
      return;
    }

    uploadingRef.current = true;
    setUploading(true);
    try {
      const presignResponse = await fetch('/api/documents/presign', {
        body: JSON.stringify({
          mime_type: mimeType,
          original_filename: file.name,
          size_bytes: file.size,
        }),
        headers: requestHeaders(),
        method: 'POST',
      });
      const presign = (await presignResponse.json()) as Partial<PresignResponse>;
      if (
        !presignResponse.ok ||
        presign.objectKey === undefined ||
        presign.uploadUrl === undefined
      ) {
        throw new Error(`Unable to prepare document upload (HTTP ${presignResponse.status}).`);
      }

      const objectResponse = await fetch(presign.uploadUrl, {
        body: file,
        headers: { 'content-type': mimeType },
        method: 'PUT',
      });
      if (!objectResponse.ok) {
        throw new Error(`Document transfer failed (HTTP ${objectResponse.status}).`);
      }

      const registerResponse = await fetch('/api/documents', {
        body: JSON.stringify({
          mime_type: mimeType,
          object_key: presign.objectKey,
          original_filename: file.name,
          size_bytes: file.size,
        }),
        headers: requestHeaders(),
        method: 'POST',
      });
      if (!registerResponse.ok) {
        throw new Error(
          `Kid-OS could not verify the uploaded document (HTTP ${registerResponse.status}).`,
        );
      }

      setFile(null);
      if (inputRef.current !== null) inputRef.current.value = '';
      setStatus('Document accepted for extraction.');
      try {
        await refreshDocuments();
      } catch {
        setError('Document accepted, but the document list could not be refreshed.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to upload document.');
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
      <section
        aria-labelledby="documents-heading"
        className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold" id="documents-heading">
            Recent documents
          </h2>
          <span className="text-xs font-medium text-slate-500">Latest 50</span>
        </div>

        {listUnavailable ? (
          <p aria-live="polite" className="mt-4 text-sm text-rose-800">
            Documents are unavailable.
          </p>
        ) : documents.length === 0 ? (
          <p className="mt-4 text-sm text-slate-600">No documents uploaded.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-200" data-testid="documents-list">
            {documents.map((document) => (
              <li className="py-4" key={document.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold">{document.originalFilename}</p>
                    <p className="mt-1 text-xs text-slate-600">
                      {formatBytes(document.sizeBytes)} ·{' '}
                      <time dateTime={document.createdAt}>
                        {formatDocumentDateTime(document.createdAt)}
                      </time>
                    </p>
                  </div>
                  <span
                    className={`rounded px-2 py-1 text-xs font-semibold ${statusTone(document.status)}`}
                    data-testid="document-status"
                  >
                    {statusLabel(document.status)}
                  </span>
                </div>
                {document.failureReason !== null ? (
                  <p className="mt-2 text-sm text-rose-800">
                    {failureLabel(document.failureReason)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="upload-document-heading"
        className="self-start rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200"
      >
        <h2 className="text-lg font-semibold" id="upload-document-heading">
          Upload document
        </h2>
        <form className="mt-4 space-y-4" onSubmit={(event) => void upload(event)}>
          <label className="block text-sm font-medium text-slate-700">
            Document file
            <input
              accept=".docx,.jpeg,.jpg,.md,.pdf,.png,.txt"
              className="mt-2 block w-full text-sm file:mr-3 file:min-h-11 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:font-semibold file:text-slate-800"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              ref={inputRef}
              type="file"
            />
          </label>
          <p className="text-xs text-slate-600">
            PDF, Word, image, text, or Markdown · 25 MB maximum
          </p>
          <button
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-400"
            disabled={uploading}
            type="submit"
          >
            <Upload aria-hidden="true" className="size-4" />
            {uploading ? 'Uploading…' : 'Upload document'}
          </button>
        </form>
        {error !== null ? (
          <p className="mt-3 text-sm text-rose-700" role="alert">
            {error}
          </p>
        ) : null}
        {status !== null ? (
          <output className="mt-3 block text-sm text-emerald-800">{status}</output>
        ) : null}
      </section>
    </div>
  );
}

function requestHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'idempotency-key': crypto.randomUUID(),
    'x-careos-correlation-id': crypto.randomUUID(),
  };
}

function documentMimeType(file: File): string | null {
  if (SUPPORTED_MIME_TYPES.has(file.type)) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase();
  return extension === undefined ? null : (MIME_BY_EXTENSION[extension] ?? null);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DOCUMENT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: 'short',
  timeZone: 'Europe/London',
  year: 'numeric',
});

export function formatDocumentDateTime(iso: string): string {
  const parts = Object.fromEntries(
    DOCUMENT_DATE_TIME_FORMATTER.formatToParts(new Date(iso)).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

function statusLabel(status: DocumentStatus): string {
  if (status === 'uploaded') return 'Queued';
  if (status === 'extracting') return 'Extracting';
  if (status === 'extracted') return 'Ready';
  return 'Unavailable';
}

function statusTone(status: DocumentStatus): string {
  if (status === 'uploaded') return 'bg-amber-50 text-amber-900';
  if (status === 'extracting') return 'bg-cyan-50 text-cyan-900';
  if (status === 'extracted') return 'bg-emerald-50 text-emerald-900';
  return 'bg-rose-50 text-rose-900';
}

function failureLabel(reason: string): string {
  return reason === 'docling-unavailable' ? 'Document extraction is unavailable.' : reason;
}
