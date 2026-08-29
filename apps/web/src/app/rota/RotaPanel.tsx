'use client';

import { useMemo, useState, useTransition } from 'react';

export interface RotaShift {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly requiredRole: string;
  readonly minHeadcount: number;
  readonly assignedUserIds: readonly string[];
}

export interface RotaRule {
  readonly id: string;
  readonly name: string;
  readonly kind: 'min_staffing' | 'gender_mix' | 'qualification_flag';
  readonly parameters: Record<string, unknown>;
  readonly active: boolean;
}

export interface RotaOverview {
  readonly shifts: readonly RotaShift[];
  readonly rules: readonly RotaRule[];
}

interface RotaGap {
  readonly shiftId: string;
  readonly kind: 'min_staffing' | 'gender_mix' | 'qualification_flag';
  readonly ruleName: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly detail: string;
}

interface RotaProposal {
  readonly shiftId: string;
  readonly addUserIds: readonly string[];
  readonly removeUserIds: readonly string[];
  readonly reason: string;
  readonly resolvedGapKinds: readonly RotaGap['kind'][];
}

interface AnalyzeResponse {
  readonly correlationId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly shifts: readonly RotaShift[];
  readonly gaps: readonly RotaGap[];
  readonly proposals: readonly RotaProposal[];
  readonly narration: string;
}

interface PublishResponse {
  readonly publicationId: string;
  readonly workflowId: string;
  readonly status: string;
}

interface Props {
  readonly canPublish: boolean;
  readonly overview: RotaOverview;
}

export function RotaPanel({ canPublish, overview }: Props) {
  const defaults = useMemo(() => deriveDefaultRange(overview.shifts), [overview.shifts]);
  const [periodStart, setPeriodStart] = useState(defaults.start);
  const [periodEnd, setPeriodEnd] = useState(defaults.end);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [publication, setPublication] = useState<PublishResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function runAnalysis() {
    setError(null);
    setPublication(null);
    startTransition(() => {
      void postJson<AnalyzeResponse>('/api/rota/analyze', {
        period_start: new Date(periodStart).toISOString(),
        period_end: new Date(periodEnd).toISOString(),
      })
        .then((data) => setAnalysis(data))
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'Failed to analyze rota.');
        });
    });
  }

  function publish() {
    if (analysis === null || analysis.shifts.length === 0) return;
    setError(null);
    startTransition(() => {
      void postJson<PublishResponse>('/api/rota/publish', {
        period_start: analysis.periodStart,
        period_end: analysis.periodEnd,
        shift_ids: analysis.shifts.map((shift) => shift.id),
      })
        .then((data) => setPublication(data))
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'Failed to publish rota.');
        });
    });
  }

  return (
    <section className="space-y-6">
      <div className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-base font-semibold">Analyze rota</h2>
        <p className="mt-1 text-sm text-slate-600">
          Run the deterministic solver over the selected period. Hermes will narrate any gaps it
          finds; publishing is a separate, manager-only action.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-medium text-slate-700">
            Period start
            <input
              aria-label="Period start"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              onChange={(event) => setPeriodStart(event.target.value)}
              type="datetime-local"
              value={periodStart}
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Period end
            <input
              aria-label="Period end"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              onChange={(event) => setPeriodEnd(event.target.value)}
              type="datetime-local"
              value={periodEnd}
            />
          </label>
          <div className="flex items-end">
            <button
              className="w-full rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={isPending || periodStart === '' || periodEnd === ''}
              onClick={runAnalysis}
              type="button"
            >
              Analyze
            </button>
          </div>
        </div>
        {error !== null ? (
          <p className="mt-4 rounded-md bg-rose-50 p-3 text-sm text-rose-900 ring-1 ring-rose-100">
            {error}
          </p>
        ) : null}
      </div>

      {analysis !== null ? (
        <div className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">Findings</h2>
            {canPublish ? (
              <button
                className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                disabled={isPending || analysis.shifts.length === 0}
                onClick={publish}
                type="button"
              >
                Publish rota
              </button>
            ) : null}
          </div>
          <p className="mt-3 text-sm text-slate-700" data-testid="rota-narration">
            {analysis.narration || 'No narration available.'}
          </p>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold">Gaps</h3>
              {analysis.gaps.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">No gaps detected.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {analysis.gaps.map((gap, index) => (
                    <li
                      className="rounded-md border border-slate-200 p-3 text-sm"
                      key={`${gap.shiftId}-${gap.kind}-${index}`}
                    >
                      <span className="mr-2 rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-100">
                        {gap.kind.replace('_', ' ')}
                      </span>
                      <span className="font-medium">{gap.ruleName}</span>
                      <p className="mt-1 text-slate-700">{gap.detail}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold">Proposals</h3>
              {analysis.proposals.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">No proposals.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {analysis.proposals.map((proposal) => (
                    <li
                      className="rounded-md border border-slate-200 p-3 text-sm"
                      key={proposal.shiftId}
                    >
                      <p className="font-medium">Shift {proposal.shiftId.slice(0, 8)}…</p>
                      <p className="mt-1 text-slate-700">
                        Add: {proposal.addUserIds.join(', ') || '—'}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">{proposal.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {publication !== null ? (
        <div className="rounded-md bg-emerald-50 p-4 text-sm text-emerald-900 ring-1 ring-emerald-100">
          Rota published. Publication id: {publication.publicationId}.
        </div>
      ) : null}

      <div className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-base font-semibold">Active rules</h2>
        {overview.rules.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No rota rules configured.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {overview.rules.map((rule) => (
              <li className="rounded-md border border-slate-200 p-3 text-sm" key={rule.id}>
                <p className="font-medium">{rule.name}</p>
                <p className="text-slate-600">{rule.kind.replace('_', ' ')}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
      'x-careos-correlation-id': crypto.randomUUID(),
    },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`Request failed (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}

function deriveDefaultRange(shifts: readonly RotaShift[]): { start: string; end: string } {
  if (shifts.length === 0) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
    return { end: toLocalInput(end), start: toLocalInput(start) };
  }
  const sorted = [...shifts].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime() + 7 * 24 * 3600 * 1000);
    return { end: toLocalInput(end), start: toLocalInput(start) };
  }
  return {
    end: toLocalInput(new Date(last.endsAt)),
    start: toLocalInput(new Date(first.startsAt)),
  };
}

function toLocalInput(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
