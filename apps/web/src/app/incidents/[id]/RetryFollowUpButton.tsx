'use client';

import { useRouter } from 'next/navigation';
import { useState, type JSX } from 'react';

export function RetryFollowUpButton({
  actionId,
  incidentId,
}: {
  readonly actionId: string;
  readonly incidentId: string;
}): JSX.Element {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry(): Promise<void> {
    setRetrying(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/incidents/${encodeURIComponent(incidentId)}/follow-ups/${encodeURIComponent(actionId)}/retry`,
        {
          body: '{}',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': crypto.randomUUID(),
            'x-careos-correlation-id': crypto.randomUUID(),
          },
          method: 'POST',
        },
      );
      if (!response.ok) {
        throw new Error(`Unable to retry follow-up (HTTP ${response.status}).`);
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to retry follow-up.');
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div>
      <button
        className="min-h-10 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 disabled:text-slate-400"
        disabled={retrying}
        onClick={() => void retry()}
        type="button"
      >
        {retrying ? 'Retrying…' : 'Retry follow-up'}
      </button>
      {error !== null ? (
        <p className="mt-2 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
