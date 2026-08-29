// Phase 1 §8: incident PDF export — Gotenberg → object storage.
//
// Split out so the pure helpers (HTML rendering, object-key naming, Gotenberg
// multipart construction) can be unit-tested without touching the network or
// the bucket. The activity itself orchestrates them and writes the resulting
// object key to core.incidents.

import { createHash } from 'node:crypto';

import type { ExportPdfInput } from '@careos/contracts';
import {
  MinioObjectStorage,
  createObjectStorage,
  type MinioClientLike,
  type ObjectStorage,
} from '@careos/object-storage';

export interface RenderedIncident {
  readonly title: string;
  readonly html: string;
}

const DEFAULT_GOTENBERG_URL = 'http://gotenberg:3000';
const DEFAULT_BUCKET = 'careos-incidents';

export function objectKeyFor(input: ExportPdfInput): string {
  return `incidents/${input.tenantId}/${input.incidentId}/v${input.version}.pdf`;
}

export function renderIncidentHtml(input: ExportPdfInput): RenderedIncident {
  const title = `Incident ${input.incidentId} · v${input.version}`;
  const rows = Object.entries(input.formData)
    .map(([key, value]) => {
      const safeKey = escapeHtml(key);
      const safeValue = escapeHtml(formatValue(value));
      return `<tr><th>${safeKey}</th><td>${safeValue}</td></tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; margin: 32px; color: #0f172a; }
      h1 { font-size: 18px; margin: 0 0 4px; }
      .meta { color: #475569; font-size: 12px; margin-bottom: 24px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #e2e8f0; padding: 8px 4px; text-align: left; vertical-align: top; font-size: 13px; }
      th { width: 30%; color: #475569; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      Template ${escapeHtml(input.formTemplate.templateId)}@${escapeHtml(input.formTemplate.version)} · Resident ${escapeHtml(input.residentId)}
    </div>
    <table>${rows}</table>
  </body>
</html>`;

  return { html, title };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export interface GotenbergConverter {
  htmlToPdf(html: string): Promise<Buffer>;
}

export function createGotenbergConverter(
  gatewayUrl: string = process.env.GOTENBERG_URL ?? DEFAULT_GOTENBERG_URL,
  fetchImpl: typeof fetch = fetch,
): GotenbergConverter {
  return {
    async htmlToPdf(html: string): Promise<Buffer> {
      const form = new FormData();
      form.set('files', new Blob([html], { type: 'text/html' }), 'index.html');

      const response = await fetchImpl(new URL('/forms/chromium/convert/html', gatewayUrl), {
        body: form,
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`gotenberg: convert returned ${response.status} ${response.statusText}`);
      }

      return Buffer.from(await response.arrayBuffer());
    },
  };
}

export interface ObjectStore {
  putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
  ensureBucket(bucket: string): Promise<void>;
}

export function createMinioStore(client?: MinioClientLike): ObjectStore {
  const store: ObjectStorage =
    client === undefined ? createObjectStorage() : new MinioObjectStorage({ client });
  return {
    async ensureBucket(bucket: string): Promise<void> {
      await store.ensureContainer(bucket);
    },
    async putObject(bucket, key, body, contentType): Promise<void> {
      await store.putObject(bucket, key, body, contentType);
    },
  };
}

export function exportBucketName(): string {
  return (
    process.env.OBJECT_STORAGE_INCIDENTS_CONTAINER ??
    process.env.MINIO_INCIDENTS_BUCKET ??
    DEFAULT_BUCKET
  );
}

export function sha256Hex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
