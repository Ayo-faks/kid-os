'use client';

import type { JsonSchema, UiSchema } from '@careos/schemas/runtime';
import { ClipboardCheck } from 'lucide-react';
import { useState, type JSX } from 'react';

import { SchemaForm, type SchemaFormSubmitResult } from '@/components/schema-form';

interface CreateHandoverProps {
  readonly initialCorrelationId?: string;
  readonly initialEndedAt: string;
  readonly schema: JsonSchema;
  readonly templateId: string;
  readonly templateTitle: string;
  readonly templateVersion: string;
  readonly uiSchema: UiSchema;
}

interface CreateHandoverResponse {
  readonly id: string;
  readonly status: string;
  readonly workflowId: string;
}

export function CreateHandover({
  initialCorrelationId,
  initialEndedAt,
  schema,
  templateId,
  templateTitle,
  templateVersion,
  uiSchema,
}: CreateHandoverProps): JSX.Element {
  const [correlationId] = useState(() => createCorrelationId(initialCorrelationId));
  const [transcriptObjectKey, setTranscriptObjectKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submitHandover(result: SchemaFormSubmitResult): Promise<void> {
    setSubmitting(true);
    setError(null);
    setStatus(null);

    try {
      const shiftId = result.formData.shiftId;
      const narrative = result.formData.narrative;
      if (typeof shiftId !== 'string' || shiftId.length === 0) {
        throw new Error('Enter the shift id before submitting.');
      }
      if (typeof narrative !== 'string' || narrative.trim().length < 10) {
        throw new Error('Enter at least 10 characters of handover notes.');
      }

      const response = await fetch('/api/handovers', {
        body: JSON.stringify({
          free_text: narrative,
          shift_id: shiftId,
          transcript_object_key: transcriptObjectKey.trim() || undefined,
        }),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          'x-careos-correlation-id': correlationId,
        },
        method: 'POST',
      });

      const payload = (await response.json()) as unknown;
      if (!response.ok || !isCreateHandoverResponse(payload)) {
        throw new Error('Unable to start handover workflow.');
      }

      setStatus(`Handover ${payload.id} is processing.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start handover workflow.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
      <section className="rounded-md bg-slate-950 p-5 text-white shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-300">{templateTitle}</p>
            <h2 className="text-lg font-semibold">Shift-end notes</h2>
          </div>
          <ClipboardCheck className="size-5 text-cyan-200" aria-hidden="true" />
        </div>

        <p className="mb-4 rounded-md bg-white/10 px-3 py-2 text-xs text-slate-100 ring-1 ring-white/10">
          Correlation ID <span className="font-mono">{correlationId}</span>
        </p>

        <label className="block" htmlFor="transcript-object-key">
          <span className="text-sm font-medium text-slate-100">Transcript object key</span>
          <input
            className="mt-2 h-10 w-full rounded-md border border-white/10 bg-white/10 px-3 py-2 text-sm text-white shadow-sm outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-cyan-300"
            id="transcript-object-key"
            onChange={(event) => setTranscriptObjectKey(event.target.value)}
            placeholder="Optional MinIO object key"
            value={transcriptObjectKey}
          />
        </label>
      </section>

      <section className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Schema-driven UI</p>
            <h2 className="text-lg font-semibold">Handover details</h2>
          </div>
          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
            {templateId}@{templateVersion}
          </span>
        </div>

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

        <SchemaForm
          defaultValues={{ endedAt: initialEndedAt, residentsRequiringFollowUp: [] }}
          disabled={submitting}
          onSubmit={submitHandover}
          schema={schema}
          submitLabel={submitting ? 'Starting...' : 'Start handover workflow'}
          uiSchema={normalizeHandoverUiSchema(uiSchema)}
        />
      </section>
    </div>
  );
}

function normalizeHandoverUiSchema(uiSchema: UiSchema): UiSchema {
  return {
    ...uiSchema,
    widgets: {
      ...uiSchema.widgets,
      openTasks: { widget: 'tag-input' },
      shiftId: { widget: 'text' },
    },
  };
}

function isCreateHandoverResponse(value: unknown): value is CreateHandoverResponse {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.status === 'string' &&
    typeof value.workflowId === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createCorrelationId(initialCorrelationId: string | undefined): string {
  if (initialCorrelationId !== undefined && initialCorrelationId.length > 0) {
    return initialCorrelationId;
  }
  return 'phase2-unset';
}
