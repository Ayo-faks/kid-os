import { redirect } from 'next/navigation';

import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';

interface ResidentRow {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly preferredName: string | null;
  readonly arrivedAt: string;
}

interface ResidentsList {
  readonly items: readonly ResidentRow[];
}

export default async function ResidentsPage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/residents');
  }

  const result = await apiFetch<ResidentsList>('/residents');

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Residents</p>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">Residents</h1>
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            ← Dashboard
          </a>
        </div>

        {!result.ok ? (
          <p className="rounded-md bg-rose-50 p-4 text-sm text-rose-900 ring-1 ring-rose-100">
            Failed to load residents (HTTP {result.status}).
          </p>
        ) : result.data.items.length === 0 ? (
          <p className="rounded-md bg-white p-6 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">
            No residents in scope for this home yet.
          </p>
        ) : (
          <ul className="grid gap-3">
            {result.data.items.map((resident) => (
              <li key={resident.id}>
                <a
                  className="flex items-center justify-between rounded-md bg-white px-4 py-3 shadow-sm ring-1 ring-slate-200 transition hover:ring-slate-300"
                  href={`/residents/${resident.id}`}
                >
                  <div>
                    <p className="text-sm font-semibold">
                      {resident.preferredName ?? resident.firstName} {resident.lastName}
                    </p>
                    <p className="text-xs text-slate-600">
                      Arrived {new Date(resident.arrivedAt).toLocaleDateString('en-GB')}
                    </p>
                  </div>
                  <span aria-hidden="true" className="text-slate-400">
                    →
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
