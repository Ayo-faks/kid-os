import { randomUUID } from 'node:crypto';

import { FORM_TEMPLATES, loadFormTemplate } from '@careos/schemas';
import { redirect } from 'next/navigation';

import { CreateIncidentFromPrompt } from './CreateIncidentFromPrompt';

import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';

interface ResidentRow {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly preferredName: string | null;
}

interface ResidentsList {
  readonly items: readonly ResidentRow[];
}

export default async function NewIncidentPage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/incidents/new');
  }

  const templates = FORM_TEMPLATES.filter((template) => template.id.startsWith('incident.')).map(
    (template) => loadFormTemplate(template.id, template.version),
  );
  const residents = await apiFetch<ResidentsList>('/residents');

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Incidents</p>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">
              Create incident from prompt
            </h1>
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
        </div>

        <CreateIncidentFromPrompt
          residents={
            residents.ok
              ? residents.data.items.map((resident) => ({
                  displayName: `${resident.preferredName ?? resident.firstName} ${resident.lastName}`,
                  id: resident.id,
                }))
              : []
          }
          initialCorrelationId={process.env.PHASE1_CORRELATION_ID ?? `phase1-${randomUUID()}`}
          templates={templates.map((template) => ({
            id: template.ref.id,
            schema: template.schema,
            title: template.ref.title,
            uiSchema: template.uiSchema,
            version: template.ref.version,
          }))}
        />
      </div>
    </main>
  );
}
