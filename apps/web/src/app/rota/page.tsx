import { redirect } from 'next/navigation';

import { RotaPanel, type RotaOverview } from './RotaPanel';

import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';
import { ROTA_PUBLISH_ROLES, hasAnyCareosRole } from '@/lib/roles';

export default async function RotaPage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/rota');
  }

  const result = await apiFetch<RotaOverview>('/rota');
  const canPublish = hasAnyCareosRole(session.roles, ROTA_PUBLISH_ROLES);

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Rota</p>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">Rota assist</h1>
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
        </div>

        {!result.ok ? (
          <p className="rounded-md bg-rose-50 p-4 text-sm text-rose-900 ring-1 ring-rose-100">
            Failed to load rota (HTTP {result.status}).
          </p>
        ) : (
          <RotaPanel canPublish={canPublish} overview={result.data} />
        )}
      </div>
    </main>
  );
}
