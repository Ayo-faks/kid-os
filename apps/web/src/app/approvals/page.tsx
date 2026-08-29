import { redirect } from 'next/navigation';

import { ApprovalQueue, type ApprovalQueueItem } from './ApprovalQueue';

import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';
import { APPROVAL_ROLES, hasAnyCareosRole } from '@/lib/roles';

interface ApprovalQueueResponse {
  readonly items: readonly ApprovalQueueItem[];
}

export default async function ApprovalsPage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/approvals');
  }

  if (!hasAnyCareosRole(session.roles, APPROVAL_ROLES)) {
    return (
      <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
        <div className="mx-auto max-w-4xl">
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
          <section className="mt-6 border-t border-slate-200 py-8">
            <p className="text-sm font-medium text-slate-600">Approvals</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal md:text-3xl">
              Approvals access is restricted
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              Approval decisions are available to managers, safeguarding leads, and operations
              administrators.
            </p>
          </section>
        </div>
      </main>
    );
  }

  const result = await apiFetch<ApprovalQueueResponse>('/approvals');

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Approvals</p>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">Approvals</h1>
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
        </div>

        {!result.ok ? (
          <p className="rounded-md bg-rose-50 p-4 text-sm text-rose-900 ring-1 ring-rose-100">
            Failed to load approvals (HTTP {result.status}).
          </p>
        ) : (
          <ApprovalQueue initialItems={result.data.items} />
        )}
      </div>
    </main>
  );
}
