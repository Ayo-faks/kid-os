import { redirect } from 'next/navigation';

import { MattermostPanel, type ChannelMappingsView } from './MattermostPanel';

import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';
import { MATTERMOST_ADMIN_ROLES, hasAnyCareosRole } from '@/lib/roles';

export default async function MattermostPage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/comms/mattermost');
  }

  if (!hasAnyCareosRole(session.roles, MATTERMOST_ADMIN_ROLES)) {
    return (
      <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
        <div className="mx-auto max-w-3xl">
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
          <h1 className="mt-6 text-2xl font-semibold tracking-normal">
            Mattermost access is restricted
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Channel mappings are available to managers and operations administrators.
          </p>
        </div>
      </main>
    );
  }

  const result = await apiFetch<ChannelMappingsView>('/comms/mattermost/channels');

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Communications</p>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">Mattermost</h1>
            <p className="mt-1 text-sm text-slate-600">
              Wire each channel kind to a Mattermost channel ID and generate one-time
              <code className="ml-1 rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">/link</code>
              codes for staff.
            </p>
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
        </div>

        {!result.ok ? (
          <p className="rounded-md bg-rose-50 p-4 text-sm text-rose-900 ring-1 ring-rose-100">
            Failed to load channel mappings (HTTP {result.status}).
          </p>
        ) : (
          <MattermostPanel initial={result.data} />
        )}
      </div>
    </main>
  );
}
