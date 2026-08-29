'use client';

import { Check, X } from 'lucide-react';
import { useState, useTransition } from 'react';

export interface ApprovalQueueItem {
  readonly id: string;
  readonly subjectType: 'email_draft' | 'incident';
  readonly subjectId: string;
  readonly title: string;
  readonly summary: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly requestedByUserId: string;
  readonly createdAt: string;
  readonly requiredRoles: readonly ('manager' | 'safeguarding_lead')[];
  readonly coveredRoles: readonly ('manager' | 'safeguarding_lead')[];
  readonly missingRoles: readonly ('manager' | 'safeguarding_lead')[];
  readonly signaturesRequired: 1 | 2;
  readonly signaturesRecorded: number;
  readonly currentUserHasSigned: boolean;
  readonly signedByUserIds: readonly string[];
  readonly signedRoles: readonly string[];
  readonly emailDraft: {
    readonly recipientEmail: string;
    readonly subject: string;
    readonly sensitivity: 'routine' | 'sensitive';
    readonly status: string;
  } | null;
  readonly incident: {
    readonly residentId: string;
    readonly residentName: string;
    readonly status: string;
    readonly templateId: string;
  } | null;
}

interface Props {
  readonly initialItems: readonly ApprovalQueueItem[];
}

export function ApprovalQueue({ initialItems }: Props) {
  const [items, setItems] = useState(() =>
    initialItems.map((item) => ({
      ...item,
      localDecisionSubmitted: item.currentUserHasSigned,
      localSignaturesRecorded: item.signaturesRecorded,
      localStatus: item.status,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const pendingCount = items.filter((item) => item.localStatus === 'pending').length;

  function decide(approvalId: string, decision: 'approve' | 'reject') {
    setError(null);
    startTransition(() => {
      void submitDecision(approvalId, decision)
        .then(() => {
          setItems((current) =>
            current.map((item) => (item.id === approvalId ? localDecision(item, decision) : item)),
          );
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'Unable to update approval.');
        });
    });
  }

  return (
    <section className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Review queue</h2>
        <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
          {pendingCount} pending
        </span>
      </div>

      {error !== null ? (
        <p className="mb-4 rounded-md bg-rose-50 p-3 text-sm text-rose-900 ring-1 ring-rose-100">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-slate-600">No approvals are waiting for review.</p>
      ) : (
        <ul className="grid gap-3">
          {items.map((item) => (
            <li className="rounded-md border border-slate-200 p-4" key={item.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-100">
                      {item.subjectType === 'incident'
                        ? (item.incident?.templateId.replace('incident.', '') ?? 'incident')
                        : (item.emailDraft?.sensitivity ?? 'email')}
                    </span>
                    <span
                      className="rounded-md bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-900 ring-1 ring-cyan-100"
                      data-testid="approval-signatures-progress"
                    >
                      {item.localSignaturesRecorded} of {item.signaturesRequired} sign-off
                      {item.signaturesRequired === 1 ? '' : 's'}
                    </span>
                    <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                      {item.localStatus.replace('_', ' ')}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold text-slate-950">{item.title}</h3>
                  <p className="mt-1 line-clamp-3 text-sm text-slate-600">{item.summary}</p>
                  {item.localDecisionSubmitted && item.localStatus === 'pending' ? (
                    <p className="mt-2 text-sm font-medium text-cyan-800">
                      Your decision is recorded. Another required role must complete this review.
                    </p>
                  ) : null}
                  <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                    <div>
                      <dt className="font-medium text-slate-500">
                        {item.subjectType === 'incident' ? 'Resident' : 'Recipient'}
                      </dt>
                      <dd className="truncate text-slate-800">
                        {item.subjectType === 'incident'
                          ? (item.incident?.residentName ?? 'Unavailable')
                          : (item.emailDraft?.recipientEmail ?? 'Unavailable')}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Required roles</dt>
                      <dd className="text-slate-800">
                        {item.requiredRoles.map(formatRole).join(' + ')}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Still needed</dt>
                      <dd className="text-slate-800">
                        {item.missingRoles.length > 0
                          ? item.missingRoles.map(formatRole).join(' + ')
                          : 'None'}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Requested</dt>
                      <dd className="text-slate-800">
                        {new Date(item.createdAt).toLocaleString('en-GB', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    aria-label={`Approve ${item.title}`}
                    className="flex size-10 items-center justify-center rounded-md bg-emerald-700 text-white shadow-sm transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                    disabled={
                      item.localStatus !== 'pending' || item.localDecisionSubmitted || isPending
                    }
                    onClick={() => decide(item.id, 'approve')}
                    title="Approve"
                    type="button"
                  >
                    <Check className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    aria-label={`Reject ${item.title}`}
                    className="flex size-10 items-center justify-center rounded-md bg-rose-700 text-white shadow-sm transition hover:bg-rose-800 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                    disabled={
                      item.localStatus !== 'pending' || item.localDecisionSubmitted || isPending
                    }
                    onClick={() => decide(item.id, 'reject')}
                    title="Reject"
                    type="button"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function localDecision(
  item: ApprovalQueueItem & {
    readonly localDecisionSubmitted: boolean;
    readonly localSignaturesRecorded: number;
    readonly localStatus: ApprovalQueueItem['status'];
  },
  decision: 'approve' | 'reject',
) {
  if (decision === 'reject') {
    return { ...item, localDecisionSubmitted: true, localStatus: 'rejected' as const };
  }
  const localSignaturesRecorded = Math.min(
    item.signaturesRequired,
    item.localSignaturesRecorded + 1,
  );
  return {
    ...item,
    localDecisionSubmitted: true,
    localSignaturesRecorded,
    localStatus:
      localSignaturesRecorded >= item.signaturesRequired
        ? ('approved' as const)
        : ('pending' as const),
  };
}

function formatRole(role: 'manager' | 'safeguarding_lead'): string {
  return role === 'safeguarding_lead' ? 'Safeguarding lead' : 'Manager';
}

async function submitDecision(approvalId: string, decision: 'approve' | 'reject'): Promise<void> {
  const response = await fetch(`/api/approvals/${approvalId}/${decision}`, {
    body: JSON.stringify({}),
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
      'x-careos-correlation-id': crypto.randomUUID(),
    },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`Approval update failed (HTTP ${response.status}).`);
  }
}
