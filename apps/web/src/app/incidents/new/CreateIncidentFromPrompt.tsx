'use client';

import type { JsonSchema, UiSchema } from '@careos/schemas/runtime';
import { Loader2, Wand2 } from 'lucide-react';
import { useState, type JSX } from 'react';

import { clearIncidentSubmissionPending, markIncidentSubmissionPending } from '../submission-state';

import {
  SchemaForm,
  type ResidentOption,
  type SchemaFormSubmitResult,
} from '@/components/schema-form';

interface CreateIncidentFromPromptProps {
  readonly initialCorrelationId?: string;
  readonly residents: readonly ResidentOption[];
  readonly templates: ReadonlyArray<{
    readonly id: string;
    readonly schema: JsonSchema;
    readonly title: string;
    readonly uiSchema: UiSchema;
    readonly version: string;
  }>;
}

interface DraftIncidentResponse {
  readonly confidence: number;
  readonly form_data: Record<string, unknown>;
  readonly missing_mandatory: readonly string[];
}

interface CreateIncidentResponse {
  readonly id: string;
  readonly status: string;
  readonly workflowId: string;
}

export function CreateIncidentFromPrompt({
  initialCorrelationId,
  residents,
  templates,
}: CreateIncidentFromPromptProps): JSX.Element {
  const [selectedTemplateKey, setSelectedTemplateKey] = useState(
    () => `${templates[0]?.id ?? ''}@${templates[0]?.version ?? ''}`,
  );
  const template =
    templates.find((candidate) => `${candidate.id}@${candidate.version}` === selectedTemplateKey) ??
    templates[0];
  const [correlationId] = useState(() => createCorrelationId(initialCorrelationId));
  const [prompt, setPrompt] = useState('');
  const [draft, setDraft] = useState<DraftIncidentResponse | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [incidentId, setIncidentId] = useState<string | null>(null);

  async function draftFromPrompt(): Promise<void> {
    setDrafting(true);
    setError(null);
    setStatus(null);

    try {
      const response = await fetch('/api/incidents/draft-from-text', {
        body: JSON.stringify({
          correlation_id: correlationId,
          free_text: prompt,
          resident_id: residents[0]?.id,
          template_id: template?.id,
        }),
        headers: { 'content-type': 'application/json', 'x-careos-correlation-id': correlationId },
        method: 'POST',
      });

      const payload = (await response.json()) as unknown;
      if (!response.ok || !isDraftIncidentResponse(payload)) {
        throw new Error('Unable to draft incident from prompt.');
      }

      setDraft(payload);
      setFormKey((current) => current + 1);
      setStatus(`Draft confidence ${Math.round(payload.confidence * 100)}%.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to draft incident from prompt.');
    } finally {
      setDrafting(false);
    }
  }

  async function saveDraft(result: SchemaFormSubmitResult): Promise<void> {
    setSaving(true);
    setError(null);
    setStatus(null);

    try {
      const residentId = result.formData.residentId;
      if (typeof residentId !== 'string' || residentId.length === 0) {
        throw new Error('Choose a resident before saving.');
      }

      const savedId = await persistDraft(result.formData, residentId);
      setStatus(`Draft saved as incident ${savedId}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save incident draft.');
    } finally {
      setSaving(false);
    }
  }

  async function submitForReview(result: SchemaFormSubmitResult): Promise<void> {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const residentId = result.formData.residentId;
      if (typeof residentId !== 'string' || residentId.length === 0) {
        throw new Error('Choose a resident before submitting.');
      }
      const savedId = await persistDraft(result.formData, residentId);
      const response = await fetch(`/api/incidents/${savedId}/submit`, {
        body: JSON.stringify({}),
        headers: requestHeaders(),
        method: 'POST',
      });
      if (!response.ok) throw new Error(`Unable to submit incident (HTTP ${response.status}).`);
      const approvalReady = await waitForPersistedIncident(savedId);
      if (approvalReady) {
        clearIncidentSubmissionPending(savedId);
      } else {
        markIncidentSubmissionPending(savedId);
      }
      window.location.assign(`/incidents/${savedId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to submit incident.');
    } finally {
      setSaving(false);
    }
  }

  async function waitForPersistedIncident(savedId: string): Promise<boolean> {
    const deadline = Date.now() + 60_000;
    const processingNoticeAt = Date.now() + 5_000;
    let processingNoticeShown = false;
    while (Date.now() < deadline) {
      const response = await fetch(`/api/incidents/${savedId}`, {
        headers: { 'x-careos-correlation-id': correlationId },
        method: 'GET',
      });
      if (response.ok) {
        const payload = (await response.json()) as unknown;
        if (!isRecord(payload)) throw new Error('Invalid incident response.');
        return (
          isRecord(payload) &&
          ((payload.status === 'awaiting_approval' && isRecord(payload.approval)) ||
            payload.status === 'approved' ||
            payload.status === 'rejected')
        );
      }
      if (!processingNoticeShown && Date.now() >= processingNoticeAt) {
        processingNoticeShown = true;
        setStatus(`Incident ${savedId} is saved and its approval route is processing.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      'The incident was accepted but is not readable yet. Try opening it from the incident list.',
    );
  }

  async function persistDraft(
    formData: Record<string, unknown>,
    residentId: string,
  ): Promise<string> {
    if (template === undefined) throw new Error('Choose an incident template.');
    const response = await fetch(
      incidentId === null ? '/api/incidents' : `/api/incidents/${incidentId}`,
      {
        body: JSON.stringify(
          incidentId === null
            ? {
                formTemplate: { templateId: template.id, version: template.version },
                initialFormData: formData,
                residentId,
              }
            : { formData },
        ),
        headers: requestHeaders(),
        method: incidentId === null ? 'POST' : 'PATCH',
      },
    );
    const payload = (await response.json()) as unknown;
    if (!response.ok) throw new Error(`Unable to save incident draft (HTTP ${response.status}).`);
    if (incidentId !== null) return incidentId;
    if (!isCreateIncidentResponse(payload)) throw new Error('Invalid create-incident response.');
    setIncidentId(payload.id);
    return payload.id;
  }

  function requestHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
      'x-careos-correlation-id': correlationId,
    };
  }

  if (template === undefined) {
    return <p role="alert">No incident templates are available.</p>;
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
      <section className="rounded-md bg-slate-950 p-5 text-white shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-slate-300">{template.title}</p>
            <h2 className="text-lg font-semibold">Prompt draft</h2>
          </div>
          <Wand2 className="size-5 text-cyan-200" aria-hidden="true" />
        </div>

        <p className="mb-4 rounded-md bg-white/10 px-3 py-2 text-xs text-slate-100 ring-1 ring-white/10">
          Correlation ID <span className="font-mono">{correlationId}</span>
        </p>

        <label className="mb-4 block" htmlFor="incident-template">
          <span className="text-sm font-medium text-slate-100">Incident template</span>
          <select
            className="mt-2 h-10 w-full rounded-md border border-white/10 bg-slate-900 px-3 text-sm text-white focus:ring-2 focus:ring-cyan-300"
            id="incident-template"
            onChange={(event) => {
              setSelectedTemplateKey(event.target.value);
              setDraft(null);
              setIncidentId(null);
              setFormKey((current) => current + 1);
            }}
            value={selectedTemplateKey}
          >
            {templates.map((candidate) => (
              <option
                key={`${candidate.id}@${candidate.version}`}
                value={`${candidate.id}@${candidate.version}`}
              >
                {candidate.title}
              </option>
            ))}
          </select>
        </label>

        {template.id === 'incident.safeguarding' ? (
          <p className="mb-4 rounded-md bg-amber-300/15 p-3 text-sm text-amber-50 ring-1 ring-amber-200/20">
            Safeguarding incidents require distinct manager and safeguarding-lead sign-off.
            Immediate-risk flags create an urgent internal review; no external agency is contacted
            automatically.
          </p>
        ) : null}

        <label className="block" htmlFor="incident-prompt">
          <span className="text-sm font-medium text-slate-100">Incident prompt</span>
          <textarea
            className="mt-2 min-h-44 w-full rounded-md border border-white/10 bg-white/10 px-3 py-2 text-sm text-white shadow-sm outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-cyan-300"
            id="incident-prompt"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the incident in factual staff notes."
            value={prompt}
          />
        </label>

        <button
          className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-cyan-400 px-4 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={drafting || prompt.trim().length < 10}
          onClick={() => void draftFromPrompt()}
          type="button"
        >
          {drafting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
          Draft from prompt
        </button>

        {draft?.missing_mandatory.length ? (
          <div className="mt-4 rounded-md bg-amber-300/15 p-3 text-sm text-amber-50 ring-1 ring-amber-200/20">
            Missing: {draft.missing_mandatory.join(', ')}
          </div>
        ) : null}
      </section>

      <section className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Schema-driven UI</p>
            <h2 className="text-lg font-semibold">Incident details</h2>
          </div>
          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
            {template.id}@{template.version}
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
          defaultValues={draft?.form_data}
          disabled={saving}
          key={`${selectedTemplateKey}-${formKey}`}
          onSaveDraft={saveDraft}
          onSubmit={submitForReview}
          residents={residents}
          schema={template.schema}
          submitLabel="Submit for review"
          uiSchema={template.uiSchema}
        />
      </section>
    </div>
  );
}

function isDraftIncidentResponse(value: unknown): value is DraftIncidentResponse {
  if (!isRecord(value) || typeof value.confidence !== 'number' || !isRecord(value.form_data)) {
    return false;
  }
  return (
    Array.isArray(value.missing_mandatory) &&
    value.missing_mandatory.every((item) => typeof item === 'string')
  );
}

function isCreateIncidentResponse(value: unknown): value is CreateIncidentResponse {
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
  return 'phase1-unset';
}
