'use client';

import { useState, type FormEvent, type JSX } from 'react';

interface DraftEmailProps {
  readonly initialCorrelationId?: string;
}

interface DraftEmailResponse {
  readonly id: string;
  readonly status: string;
  readonly workflowId: string;
}

export function DraftEmail({ initialCorrelationId }: DraftEmailProps): JSX.Element {
  const [correlationId] = useState(initialCorrelationId ?? 'phase2-unset');
  const [sourceKind, setSourceKind] = useState<'incident' | 'handover' | 'general'>('general');
  const [sourceId, setSourceId] = useState('');
  const [sourceSummary, setSourceSummary] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientRole, setRecipientRole] = useState('');
  const [instructions, setInstructions] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatus(null);

    try {
      if (sourceSummary.trim().length < 10) {
        throw new Error('Provide at least 10 characters of context for the email.');
      }
      if (instructions.trim().length < 10) {
        throw new Error('Provide at least 10 characters of drafting instructions.');
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(recipientEmail.trim())) {
        throw new Error('Enter a valid recipient email address.');
      }

      const body: Record<string, unknown> = {
        instructions: instructions.trim(),
        recipient: {
          email: recipientEmail.trim(),
          ...(recipientName.trim() !== '' ? { name: recipientName.trim() } : {}),
          ...(recipientRole.trim() !== '' ? { role: recipientRole.trim() } : {}),
        },
        source: {
          kind: sourceKind,
          summary: sourceSummary.trim(),
          ...(sourceId.trim() !== '' ? { id: sourceId.trim() } : {}),
        },
      };

      const response = await fetch('/api/comms/email/draft', {
        body: JSON.stringify(body),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          'x-careos-correlation-id': correlationId,
        },
        method: 'POST',
      });

      const payload = (await response.json()) as unknown;
      if (!response.ok || !isDraftEmailResponse(payload)) {
        throw new Error('Unable to start the email draft workflow.');
      }

      setStatus(
        `Email draft ${payload.id} is processing. It will be saved as a draft for review — nothing has been sent.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to start the email draft workflow.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <p className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">
        Correlation ID <span className="font-mono">{correlationId}</span>
      </p>

      {status !== null ? (
        <p className="mb-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900 ring-1 ring-emerald-100">
          {status}
        </p>
      ) : null}
      {error !== null ? (
        <p
          className="mb-4 rounded-md bg-rose-50 p-3 text-sm text-rose-900 ring-1 ring-rose-100"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="font-medium text-slate-700">Source kind</span>
            <select
              className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm"
              onChange={(event) =>
                setSourceKind(event.target.value as 'incident' | 'handover' | 'general')
              }
              value={sourceKind}
            >
              <option value="general">General</option>
              <option value="incident">Incident</option>
              <option value="handover">Handover</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="font-medium text-slate-700">Source ID (optional)</span>
            <input
              className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm"
              onChange={(event) => setSourceId(event.target.value)}
              placeholder="Optional incident or handover UUID"
              value={sourceId}
            />
          </label>
        </fieldset>

        <label className="text-sm">
          <span className="font-medium text-slate-700">Context summary</span>
          <textarea
            className="mt-1 min-h-[120px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            onChange={(event) => setSourceSummary(event.target.value)}
            placeholder="What happened? Stick to facts."
            value={sourceSummary}
          />
        </label>

        <fieldset className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="font-medium text-slate-700">Recipient email</span>
            <input
              className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm"
              onChange={(event) => setRecipientEmail(event.target.value)}
              placeholder="manager@example.com"
              type="email"
              value={recipientEmail}
            />
          </label>
          <label className="text-sm">
            <span className="font-medium text-slate-700">Recipient name</span>
            <input
              className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm"
              onChange={(event) => setRecipientName(event.target.value)}
              placeholder="Optional"
              value={recipientName}
            />
          </label>
          <label className="text-sm">
            <span className="font-medium text-slate-700">Recipient role</span>
            <input
              className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 text-sm"
              onChange={(event) => setRecipientRole(event.target.value)}
              placeholder="e.g. parent, manager"
              value={recipientRole}
            />
          </label>
        </fieldset>

        <label className="text-sm">
          <span className="font-medium text-slate-700">Drafting instructions</span>
          <textarea
            className="mt-1 min-h-[120px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="What should this email say? CareOS will mark sensitive drafts for manager review."
            value={instructions}
          />
        </label>

        <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-100">
          CareOS never sends email automatically. Sensitive drafts are routed to a manager for
          review before any delivery.
        </p>

        <div className="flex justify-end">
          <button
            className="rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white shadow-sm disabled:opacity-60"
            disabled={submitting}
            type="submit"
          >
            {submitting ? 'Starting...' : 'Draft email for review'}
          </button>
        </div>
      </form>
    </section>
  );
}

function isDraftEmailResponse(value: unknown): value is DraftEmailResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    typeof (value as Record<string, unknown>).status === 'string' &&
    typeof (value as Record<string, unknown>).workflowId === 'string'
  );
}
