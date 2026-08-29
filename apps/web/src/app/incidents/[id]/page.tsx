import { notFound, redirect } from 'next/navigation';

import type { IncidentDetail } from '../types';

import { IncidentActions } from './IncidentActions';
import { IncidentApprovalPanel } from './IncidentApprovalPanel';

import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';

export default async function IncidentDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const session = await getCareosServerSession();
  if (session === null) redirect(`/api/auth/signin?callbackUrl=/incidents/${id}`);

  const result = await apiFetch<IncidentDetail>(`/incidents/${id}`);
  if (!result.ok && result.status === 404) notFound();

  if (!result.ok) {
    return <main className="p-6">Failed to load incident (HTTP {result.status}).</main>;
  }
  const incident = result.data;
  const safeguarding = incident.formTemplate.templateId === 'incident.safeguarding';
  const currentVersion = incident.versions.find(
    (version) => version.version === incident.currentVersion,
  );
  const immediateRisk = currentVersion?.formData.isChildAtImmediateRisk === true;

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <p className="text-sm font-medium text-slate-600">{incident.formTemplate.title}</p>
            <h1 className="text-2xl font-semibold md:text-3xl">{incident.residentName}</h1>
            <p className="mt-1 text-xs text-slate-600">Incident {incident.id}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={incident.status} />
            <a className="text-sm font-medium text-cyan-800 underline" href="/incidents">
              All incidents
            </a>
          </div>
        </header>

        {safeguarding ? (
          <section className="border-l-4 border-amber-500 bg-amber-50 p-4 text-sm text-amber-950">
            <h2 className="font-semibold">Safeguarding review</h2>
            <p className="mt-1">
              This incident requires distinct manager and safeguarding-lead sign-off. External
              agencies are never contacted automatically.
            </p>
          </section>
        ) : null}

        {immediateRisk ? (
          <section
            className="border-l-4 border-rose-700 bg-rose-50 p-4 text-sm text-rose-950"
            data-testid="incident-immediate-risk"
            role="alert"
          >
            <h2 className="font-semibold">Immediate risk flagged</h2>
            <p className="mt-1">
              Prioritise internal safeguarding review and follow the home&apos;s emergency
              procedure. CareOS has not contacted any external agency.
            </p>
          </section>
        ) : null}

        <section className="grid gap-5 md:grid-cols-[1fr_0.8fr]">
          <div className="bg-white p-5 ring-1 ring-slate-200">
            <h2 className="text-base font-semibold">Current state</h2>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <Definition
                label="Template"
                value={`${incident.formTemplate.templateId}@${incident.formTemplate.version}`}
              />
              <Definition label="Version" value={String(incident.currentVersion)} />
              <Definition
                label="Created"
                value={new Date(incident.createdAt).toLocaleString('en-GB')}
              />
              <Definition
                label="Updated"
                value={new Date(incident.updatedAt).toLocaleString('en-GB')}
              />
            </dl>
            <div className="mt-5">
              <IncidentActions
                exportBundle={incident.exportBundle}
                incidentId={incident.id}
                status={incident.status}
              />
            </div>
          </div>

          <div className="bg-white p-5 ring-1 ring-slate-200">
            <h2 className="text-base font-semibold">Approval</h2>
            <IncidentApprovalPanel approval={incident.approval} incidentId={incident.id} />
          </div>
        </section>

        <section className="bg-white p-5 ring-1 ring-slate-200">
          <h2 className="text-base font-semibold">Version history</h2>
          <ol className="mt-4 divide-y divide-slate-200">
            {[...incident.versions].reverse().map((version) => (
              <li className="py-4" key={version.version}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">Version {version.version}</h3>
                  <StatusBadge status={version.status} />
                </div>
                {version.missingMandatory.length > 0 ? (
                  <p className="mt-2 text-sm text-amber-800">
                    Missing: {version.missingMandatory.join(', ')}
                  </p>
                ) : null}
                <p className="mt-2 text-xs text-slate-500">
                  {new Date(version.createdAt).toLocaleString('en-GB')} · {version.actorKind}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section className="bg-white p-5 ring-1 ring-slate-200">
          <h2 className="text-base font-semibold">Timeline</h2>
          {incident.timeline.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">No timeline entries have been recorded.</p>
          ) : (
            <ol className="mt-4 divide-y divide-slate-200">
              {incident.timeline.map((entry) => (
                <li className="py-3" key={entry.id}>
                  <div className="flex flex-col justify-between gap-1 sm:flex-row sm:items-start">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{entry.summary}</p>
                      <p className="mt-1 text-xs text-slate-600">
                        {entry.kind.replaceAll('_', ' ')}
                      </p>
                    </div>
                    <time className="text-xs text-slate-600" dateTime={entry.occurredAt}>
                      {new Date(entry.occurredAt).toLocaleString('en-GB')}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}

function Definition({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-1 text-slate-900">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  return (
    <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
      {status.replaceAll('_', ' ')}
    </span>
  );
}
