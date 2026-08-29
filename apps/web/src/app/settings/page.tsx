import { redirect } from 'next/navigation';

import { SettingsPanel, type RetentionPolicyView, type RetentionRunView } from './SettingsPanel';

import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';
import { SETTINGS_ROLES, hasAnyCareosRole } from '@/lib/roles';

interface PoliciesResponse {
  readonly policies: readonly RetentionPolicyView[];
}

interface RunsResponse {
  readonly runs: readonly RetentionRunView[];
}

export default async function SettingsPage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/settings');
  }

  if (!hasAnyCareosRole(session.roles, SETTINGS_ROLES)) {
    return (
      <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
        <div className="mx-auto max-w-4xl">
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
          <section className="mt-6 border-t border-slate-200 py-8">
            <p className="text-sm font-medium text-slate-600">Operations administration</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal md:text-3xl">
              Settings access is restricted
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              Retention settings are available to operations administrators.
            </p>
          </section>
        </div>
      </main>
    );
  }

  const [policies, runs] = await Promise.all([
    apiFetch<PoliciesResponse>('/retention/policies'),
    apiFetch<RunsResponse>('/retention/runs'),
  ]);

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-600">Operations administration</p>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">Settings</h1>
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
        </header>

        {!policies.ok ? (
          <p className="rounded-md bg-rose-50 p-4 text-sm text-rose-900 ring-1 ring-rose-100">
            Operations administrator access is required to manage retention policies.
          </p>
        ) : (
          <SettingsPanel
            initialPolicies={policies.data.policies}
            initialRuns={runs.ok ? runs.data.runs : []}
            runsUnavailable={!runs.ok}
          />
        )}
      </div>
    </main>
  );
}
