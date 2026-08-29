import { redirect } from 'next/navigation';

import { DocumentsPanel, type DocumentView } from './DocumentsPanel';

import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';

interface DocumentsResponse {
  readonly documents: readonly DocumentView[];
}

export default async function DocumentsPage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/documents');
  }

  const result = await apiFetch<DocumentsResponse>('/documents');

  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-600">Records and evidence</p>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">Documents</h1>
          </div>
          <a className="text-sm font-medium text-cyan-700 underline" href="/">
            Back to dashboard
          </a>
        </header>

        <DocumentsPanel
          initialDocuments={result.ok ? result.data.documents : []}
          listUnavailable={!result.ok}
        />
      </div>
    </main>
  );
}
