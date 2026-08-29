import { notFound, redirect } from 'next/navigation';

import { ResidentTimeline } from '@/components/resident-timeline/Timeline';
import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';

interface ResidentDetail {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly preferredName: string | null;
  readonly dateOfBirth: string;
  readonly arrivedAt: string;
  readonly leftAt: string | null;
}

export interface TimelineEntry {
  readonly id: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly incidentId: string | null;
  readonly taskId: string | null;
  readonly actorKind: string;
  readonly actorUserId: string | null;
}

export default async function ResidentDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const session = await getCareosServerSession();
  if (session === null) {
    redirect(`/api/auth/signin?callbackUrl=/residents/${id}`);
  }

  const [residentResult, timelineResult] = await Promise.all([
    apiFetch<ResidentDetail>(`/residents/${id}`),
    apiFetch<readonly TimelineEntry[]>(`/residents/${id}/timeline`),
  ]);

  if (!residentResult.ok && residentResult.status === 404) {
    notFound();
  }

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Resident</p>
            {residentResult.ok ? (
              <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">
                {residentResult.data.preferredName ?? residentResult.data.firstName}{' '}
                {residentResult.data.lastName}
              </h1>
            ) : (
              <h1 className="text-2xl font-semibold md:text-3xl">Resident</h1>
            )}
            {residentResult.ok ? (
              <p className="mt-1 text-xs text-slate-600">
                DOB {new Date(residentResult.data.dateOfBirth).toLocaleDateString('en-GB')} ·
                Arrived {new Date(residentResult.data.arrivedAt).toLocaleDateString('en-GB')}
                {residentResult.data.leftAt !== null
                  ? ` · Left ${new Date(residentResult.data.leftAt).toLocaleDateString('en-GB')}`
                  : ''}
              </p>
            ) : null}
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/residents">
            ← Residents
          </a>
        </div>

        <section className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold">Timeline</h2>
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
              {timelineResult.ok ? `${timelineResult.data.length} items` : 'unavailable'}
            </span>
          </div>
          {!timelineResult.ok ? (
            <p className="rounded-md bg-rose-50 p-4 text-sm text-rose-900 ring-1 ring-rose-100">
              Failed to load timeline (HTTP {timelineResult.status}).
            </p>
          ) : (
            <ResidentTimeline entries={timelineResult.data} />
          )}
        </section>
      </div>
    </main>
  );
}
