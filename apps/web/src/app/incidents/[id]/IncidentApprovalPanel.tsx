'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type JSX } from 'react';

import { clearIncidentSubmissionPending, isIncidentSubmissionPending } from '../submission-state';
import type { IncidentDetail } from '../types';

const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_POLL_TIMEOUT_MS = 120_000;

interface IncidentApprovalPanelProps {
  readonly approval: IncidentDetail['approval'];
  readonly incidentId: string;
}

export function IncidentApprovalPanel({
  approval,
  incidentId,
}: IncidentApprovalPanelProps): JSX.Element {
  const router = useRouter();
  const [submissionPending, setSubmissionPending] = useState(false);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  useEffect(() => {
    if (approval !== null) {
      clearIncidentSubmissionPending(incidentId);
      return;
    }
    if (!isIncidentSubmissionPending(incidentId)) return;

    setSubmissionPending(true);
    const controller = new AbortController();
    const deadline = Date.now() + APPROVAL_POLL_TIMEOUT_MS;
    let timeoutId: number | undefined;

    async function poll(): Promise<void> {
      try {
        const response = await fetch(`/api/incidents/${incidentId}`, {
          cache: 'no-store',
          headers: { 'x-careos-correlation-id': `incident-processing-${incidentId}` },
          signal: controller.signal,
        });
        if (response.ok) {
          const payload = (await response.json()) as unknown;
          if (hasMaterializedApproval(payload)) {
            clearIncidentSubmissionPending(incidentId);
            router.refresh();
            return;
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }

      if (Date.now() >= deadline) {
        setPollTimedOut(true);
        return;
      }
      timeoutId = window.setTimeout(() => void poll(), APPROVAL_POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      controller.abort();
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [approval, incidentId, router]);

  if (approval !== null) {
    return (
      <div className="mt-3 space-y-3">
        <p className="text-2xl font-semibold" data-testid="incident-approval-progress">
          {approval.signaturesRecorded} of {approval.signaturesRequired}
        </p>
        <p className="text-sm text-slate-600">
          Required: {approval.requiredRoles.map(formatRole).join(' + ')}
        </p>
        <p className="text-sm text-slate-600">
          Still needed:{' '}
          {approval.missingRoles.length > 0
            ? approval.missingRoles.map(formatRole).join(' + ')
            : 'None'}
        </p>
        <StatusBadge status={approval.status} />
      </div>
    );
  }

  if (!submissionPending) {
    return <p className="mt-3 text-sm text-slate-600">No approval request has been created yet.</p>;
  }

  return (
    <output aria-live="polite" className="mt-3 block space-y-3 text-sm text-slate-700">
      <p className="font-semibold text-slate-900">
        {pollTimedOut
          ? 'Approval routing is taking longer than expected.'
          : 'Approval routing in progress'}
      </p>
      <p>
        The incident is saved. It will remain in processing until the approval request is ready.
      </p>
      {pollTimedOut ? (
        <button
          className="font-medium text-cyan-800 underline"
          onClick={() => window.location.reload()}
          type="button"
        >
          Refresh status
        </button>
      ) : null}
      <a className="block font-medium text-cyan-800 underline" href="/incidents">
        Open incident list
      </a>
    </output>
  );
}

function hasMaterializedApproval(value: unknown): boolean {
  return isRecord(value) && isRecord(value.approval);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function StatusBadge({ status }: { readonly status: string }): JSX.Element {
  return (
    <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
      {status.replaceAll('_', ' ')}
    </span>
  );
}

function formatRole(role: 'manager' | 'safeguarding_lead'): string {
  return role === 'safeguarding_lead' ? 'Safeguarding lead' : 'Manager';
}
