import { randomUUID } from 'node:crypto';

import { loadFormTemplate } from '@careos/schemas';
import { redirect } from 'next/navigation';

import { CreateHandover } from './CreateHandover';

import { getCareosServerSession } from '@/lib/auth';

export default async function HandoversPage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/handovers');
  }

  const template = loadFormTemplate('handover.shift-end', 'v1');

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Handovers</p>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">
              Start shift-end handover
            </h1>
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
        </div>

        <CreateHandover
          initialCorrelationId={process.env.PHASE2_CORRELATION_ID ?? `phase2-${randomUUID()}`}
          initialEndedAt={new Date().toISOString()}
          schema={template.schema}
          templateId={template.ref.id}
          templateTitle={template.ref.title}
          templateVersion={template.ref.version}
          uiSchema={template.uiSchema}
        />
      </div>
    </main>
  );
}
