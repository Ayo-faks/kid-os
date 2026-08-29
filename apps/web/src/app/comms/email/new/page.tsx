import { randomUUID } from 'node:crypto';

import { redirect } from 'next/navigation';

import { DraftEmail } from './DraftEmail';

import { getCareosServerSession } from '@/lib/auth';

export default async function NewEmailDraftPage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/comms/email/new');
  }

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600">Communications</p>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">Draft an email</h1>
            <p className="mt-1 text-sm text-slate-600">
              Drafts are reviewed by a manager before any message leaves the home. Nothing is sent
              automatically.
            </p>
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
        </div>

        <DraftEmail
          initialCorrelationId={process.env.PHASE2_CORRELATION_ID ?? `phase2-${randomUUID()}`}
        />
      </div>
    </main>
  );
}
