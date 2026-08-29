'use client';

import { useState, type FormEvent, type JSX } from 'react';

export type RetentionRecordType = 'incident' | 'handover_record' | 'email_draft' | 'attachment';
export type RetentionAction = 'soft_delete' | 'object_delete';

export interface RetentionPolicyView {
  readonly action: RetentionAction;
  readonly createdAt: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly recordType: RetentionRecordType;
  readonly retentionDays: number;
  readonly updatedAt: string;
}

export interface RetentionRunView {
  readonly action: RetentionAction;
  readonly affectedCount: number;
  readonly completedAt: string | null;
  readonly failureReason: string | null;
  readonly id: string;
  readonly recordType: RetentionRecordType;
  readonly scannedCount: number;
  readonly startedAt: string;
  readonly workflowId: string;
}

const RECORD_TYPES: readonly RetentionRecordType[] = [
  'incident',
  'handover_record',
  'email_draft',
  'attachment',
];

export function SettingsPanel({
  initialPolicies,
  initialRuns,
  runsUnavailable,
}: {
  readonly initialPolicies: readonly RetentionPolicyView[];
  readonly initialRuns: readonly RetentionRunView[];
  readonly runsUnavailable: boolean;
}): JSX.Element {
  const [policies, setPolicies] = useState(initialPolicies);
  const [recordType, setRecordType] = useState<RetentionRecordType>('incident');
  const [retentionDays, setRetentionDays] = useState('365');
  const [action, setAction] = useState<RetentionAction>('soft_delete');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function selectRecordType(next: RetentionRecordType): void {
    const existing = policies.find((policy) => policy.recordType === next);
    setRecordType(next);
    setRetentionDays(String(existing?.retentionDays ?? 365));
    setAction(existing?.action ?? 'soft_delete');
    setEnabled(existing?.enabled ?? true);
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const days = Number(retentionDays);
    setError(null);
    setStatus(null);
    if (!Number.isInteger(days) || days < 0 || days > 36500) {
      setError('Retention days must be a whole number between 0 and 36500.');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/retention/policies', {
        body: JSON.stringify({
          action,
          enabled,
          record_type: recordType,
          retention_days: days,
        }),
        headers: {
          'content-type': 'application/json',
          'idempotency-key': crypto.randomUUID(),
          'x-careos-correlation-id': crypto.randomUUID(),
        },
        method: 'PUT',
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok || !isPolicy(payload)) {
        throw new Error(`Unable to save retention policy (HTTP ${response.status}).`);
      }
      setPolicies((current) =>
        [...current.filter((policy) => policy.recordType !== payload.recordType), payload].sort(
          (left, right) => left.recordType.localeCompare(right.recordType),
        ),
      );
      setStatus(`${label(payload.recordType)} policy saved.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save retention policy.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="retention-policies-heading"
        className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200"
      >
        <h2 className="text-lg font-semibold" id="retention-policies-heading">
          Retention policies
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Configure retention by record type. Attachment object deletion is verified before CareOS
          records success.
        </p>

        <ul className="mt-4 divide-y divide-slate-200" data-testid="retention-policy-list">
          {policies.length === 0 ? (
            <li className="py-3 text-sm text-slate-600">No policies configured.</li>
          ) : (
            policies.map((policy) => (
              <li
                className="flex flex-wrap items-center justify-between gap-2 py-3"
                key={policy.id}
              >
                <div>
                  <p className="text-sm font-medium">{label(policy.recordType)}</p>
                  <p className="text-xs text-slate-600">
                    {policy.retentionDays} days · {label(policy.action)}
                  </p>
                </div>
                <span className="text-xs font-medium text-slate-600">
                  {policy.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </li>
            ))
          )}
        </ul>

        <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={(event) => void save(event)}>
          <label className="text-sm font-medium text-slate-700">
            Record type
            <select
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3"
              onChange={(event) => selectRecordType(event.target.value as RetentionRecordType)}
              value={recordType}
            >
              {RECORD_TYPES.map((value) => (
                <option key={value} value={value}>
                  {label(value)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">
            Retention days
            <input
              className="mt-1 h-11 w-full rounded-md border border-slate-300 px-3"
              inputMode="numeric"
              max={36500}
              min={0}
              onChange={(event) => setRetentionDays(event.target.value)}
              type="number"
              value={retentionDays}
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Action
            <select
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3"
              onChange={(event) => setAction(event.target.value as RetentionAction)}
              value={action}
            >
              <option value="soft_delete">Soft delete</option>
              {recordType === 'attachment' ? (
                <option value="object_delete">Verified object deletion</option>
              ) : null}
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-3 self-end text-sm font-medium text-slate-700">
            <input
              checked={enabled}
              className="size-5"
              onChange={(event) => setEnabled(event.target.checked)}
              type="checkbox"
            />
            Enabled
          </label>
          <div className="md:col-span-2">
            <button
              className="min-h-11 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-400"
              disabled={saving}
              type="submit"
            >
              {saving ? 'Saving…' : 'Save policy'}
            </button>
          </div>
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

      <section
        aria-labelledby="retention-runs-heading"
        className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200"
      >
        <h2 className="text-lg font-semibold" id="retention-runs-heading">
          Recent runs
        </h2>
        {runsUnavailable ? (
          <p aria-live="polite" className="mt-3 text-sm text-rose-800">
            Retention run history is unavailable.
          </p>
        ) : initialRuns.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No retention runs recorded.</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-200" data-testid="retention-run-list">
            {initialRuns.map((run) => (
              <li className="py-3 text-sm" key={run.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {label(run.recordType)} · {label(run.action)}
                  </p>
                  <time className="text-xs text-slate-600" dateTime={run.startedAt}>
                    {new Date(run.startedAt).toLocaleString('en-GB')}
                  </time>
                </div>
                <p className="mt-1 text-slate-600">
                  Scanned {run.scannedCount}; affected {run.affectedCount}.{' '}
                  {run.failureReason ?? (run.completedAt === null ? 'In progress.' : 'Completed.')}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (first) => first.toUpperCase());
}

function isPolicy(value: unknown): value is RetentionPolicyView {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RetentionPolicyView>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.recordType === 'string' &&
    typeof candidate.retentionDays === 'number' &&
    (candidate.action === 'soft_delete' || candidate.action === 'object_delete') &&
    typeof candidate.enabled === 'boolean' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}
