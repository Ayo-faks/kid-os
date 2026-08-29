'use client';

import { Archive, Download, FileOutput } from 'lucide-react';
import { useState, useTransition } from 'react';

import type { IncidentDetail } from '../types';

export function IncidentActions({
  exportBundle,
  incidentId,
  status,
}: {
  readonly exportBundle: IncidentDetail['exportBundle'];
  readonly incidentId: string;
  readonly status: string;
}) {
  const [bundle, setBundle] = useState(exportBundle);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function exportPdf() {
    setMessage(null);
    startTransition(() => {
      void fetch(`/api/incidents/${incidentId}/export`, {
        body: JSON.stringify({}),
        headers: requestHeaders(),
        method: 'POST',
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Export failed (HTTP ${response.status}).`);
          setMessage('PDF export started. Refresh this page to see its status.');
        })
        .catch((cause: unknown) => {
          setMessage(cause instanceof Error ? cause.message : 'Unable to export incident.');
        });
    });
  }

  function downloadPdf() {
    setMessage(null);
    startTransition(() => {
      void fetch(`/api/incidents/${incidentId}/download`, { method: 'GET' })
        .then(async (response) => {
          const payload = (await response.json()) as unknown;
          if (!response.ok || !isDownloadResponse(payload)) {
            throw new Error(`Download unavailable (HTTP ${response.status}).`);
          }
          window.location.assign(payload.url);
        })
        .catch((cause: unknown) => {
          setMessage(cause instanceof Error ? cause.message : 'Unable to download incident.');
        });
    });
  }

  function requestBundle() {
    setMessage(null);
    startTransition(() => {
      void fetch('/api/export-bundles', {
        body: JSON.stringify({ incident_id: incidentId }),
        headers: requestHeaders(),
        method: 'POST',
      })
        .then(async (response) => {
          const payload = (await response.json()) as unknown;
          if (!response.ok || !isBundleRequestResponse(payload)) {
            throw new Error(`Bundle request failed (HTTP ${response.status}).`);
          }
          const now = new Date().toISOString();
          setBundle({
            createdAt: now,
            failureReason: null,
            id: payload.id,
            sizeBytes: null,
            status: payload.status,
            updatedAt: now,
          });
          setMessage('Serious-incident bundle requested. Refresh to see its latest status.');
        })
        .catch((cause: unknown) => {
          setMessage(cause instanceof Error ? cause.message : 'Unable to request bundle.');
        });
    });
  }

  function downloadBundle() {
    if (bundle === null || bundle.status !== 'ready') return;
    setMessage(null);
    startTransition(() => {
      void fetch(`/api/export-bundles/${bundle.id}/download`, { method: 'GET' })
        .then(async (response) => {
          const payload = (await response.json()) as unknown;
          if (!response.ok || !isDownloadResponse(payload)) {
            throw new Error(`Bundle download unavailable (HTTP ${response.status}).`);
          }
          window.location.assign(payload.url);
        })
        .catch((cause: unknown) => {
          setMessage(cause instanceof Error ? cause.message : 'Unable to download bundle.');
        });
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'approved' ? (
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white disabled:opacity-50"
          disabled={isPending}
          onClick={exportPdf}
          type="button"
        >
          <FileOutput className="size-4" aria-hidden="true" /> Export PDF
        </button>
      ) : null}
      {status === 'exported' ? (
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md bg-cyan-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
          disabled={isPending}
          onClick={downloadPdf}
          type="button"
        >
          <Download className="size-4" aria-hidden="true" /> Download PDF
        </button>
      ) : null}
      {(status === 'approved' || status === 'exported') &&
      (bundle === null || bundle.status === 'failed') ? (
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md bg-amber-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
          disabled={isPending}
          onClick={requestBundle}
          type="button"
        >
          <Archive className="size-4" aria-hidden="true" />
          {bundle?.status === 'failed' ? 'Retry bundle' : 'Create bundle'}
        </button>
      ) : null}
      {bundle !== null ? (
        <span
          className="inline-flex h-10 items-center rounded-md bg-slate-100 px-3 text-sm font-medium text-slate-700"
          data-testid="incident-bundle-status"
        >
          Bundle {bundle.status}
        </span>
      ) : null}
      {bundle?.status === 'ready' ? (
        <button
          className="inline-flex h-10 items-center gap-2 rounded-md bg-amber-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
          disabled={isPending}
          onClick={downloadBundle}
          type="button"
        >
          <Download className="size-4" aria-hidden="true" /> Download bundle
        </button>
      ) : null}
      {status === 'awaiting_approval' ? (
        <a className="text-sm font-semibold text-cyan-800 underline" href="/approvals">
          Open approval queue
        </a>
      ) : null}
      {message !== null ? (
        <output className="w-full text-sm text-slate-600">{message}</output>
      ) : null}
      {bundle?.status === 'failed' && bundle.failureReason !== null ? (
        <p className="w-full text-sm text-rose-800" role="alert">
          Bundle failed: {bundle.failureReason}
        </p>
      ) : null}
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

function isDownloadResponse(value: unknown): value is { readonly url: string } {
  return (
    typeof value === 'object' && value !== null && 'url' in value && typeof value.url === 'string'
  );
}

function isBundleRequestResponse(
  value: unknown,
): value is { readonly id: string; readonly status: 'pending' } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'status' in value &&
    value.status === 'pending'
  );
}
