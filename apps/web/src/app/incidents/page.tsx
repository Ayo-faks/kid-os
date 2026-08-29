import { Plus } from 'lucide-react';
import { redirect } from 'next/navigation';

import type { IncidentListItem } from './types';

import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';

export default async function IncidentsPage() {
  const session = await getCareosServerSession();
  if (session === null) redirect('/api/auth/signin?callbackUrl=/incidents');

  const result = await apiFetch<{ readonly items: readonly IncidentListItem[] }>('/incidents');

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-600">Operations</p>
            <h1 className="text-2xl font-semibold md:text-3xl">Incidents</h1>
          </div>
          <a
            className="inline-flex h-10 items-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white"
            href="/incidents/new"
          >
            <Plus className="size-4" aria-hidden="true" /> New incident
          </a>
        </header>

        {!result.ok ? (
          <p className="rounded-md bg-rose-50 p-4 text-sm text-rose-900 ring-1 ring-rose-100">
            Failed to load incidents (HTTP {result.status}).
          </p>
        ) : result.data.items.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">
            No incidents are recorded for this home.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 border-y border-slate-200 bg-white">
            {result.data.items.map((incident) => (
              <li key={incident.id}>
                <a
                  className="grid gap-2 px-4 py-4 hover:bg-slate-50 sm:grid-cols-[1fr_auto] sm:items-center"
                  href={`/incidents/${incident.id}`}
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">{incident.templateTitle}</h2>
                      <StatusBadge status={incident.status} />
                    </div>
                    <p className="mt-1 text-sm text-slate-600">
                      {incident.residentName} · version {incident.currentVersion}
                    </p>
                  </div>
                  <time className="text-xs text-slate-500" dateTime={incident.updatedAt}>
                    Updated {new Date(incident.updatedAt).toLocaleString('en-GB')}
                  </time>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  return (
    <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
      {status.replaceAll('_', ' ')}
    </span>
  );
}
