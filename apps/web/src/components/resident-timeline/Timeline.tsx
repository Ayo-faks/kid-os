import { AlertTriangle, ClipboardCheck, FileText, MessageSquare, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';

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

const KIND_META: Record<
  string,
  { readonly label: string; readonly tone: string; readonly Icon: typeof FileText }
> = {
  comm: { Icon: MessageSquare, label: 'Comm', tone: 'bg-amber-50 text-amber-900 ring-amber-100' },
  incident: {
    Icon: AlertTriangle,
    label: 'Incident',
    tone: 'bg-rose-50 text-rose-900 ring-rose-100',
  },
  note: { Icon: FileText, label: 'Note', tone: 'bg-slate-50 text-slate-900 ring-slate-200' },
  system: {
    Icon: Sparkles,
    label: 'System',
    tone: 'bg-cyan-50 text-cyan-900 ring-cyan-100',
  },
  task: {
    Icon: ClipboardCheck,
    label: 'Task',
    tone: 'bg-emerald-50 text-emerald-900 ring-emerald-100',
  },
};

const FALLBACK_META: {
  readonly label: string;
  readonly tone: string;
  readonly Icon: typeof FileText;
} = {
  Icon: FileText,
  label: 'Note',
  tone: 'bg-slate-50 text-slate-900 ring-slate-200',
};

export function ResidentTimeline({ entries }: { readonly entries: readonly TimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 p-6 text-center text-sm text-slate-600">
        No timeline activity yet. Submitting an incident or note will appear here.
      </p>
    );
  }

  return (
    <ol className="relative space-y-3 border-l border-slate-200 pl-4">
      {entries.map((entry) => {
        const meta = KIND_META[entry.kind] ?? FALLBACK_META;
        const Icon = meta.Icon;
        return (
          <li className="relative" key={entry.id}>
            <span
              aria-hidden="true"
              className="absolute -left-[22px] top-1.5 flex size-4 items-center justify-center rounded-full bg-white ring-2 ring-slate-200"
            >
              <Icon className="size-2.5 text-slate-500" />
            </span>
            <article className={cn('rounded-md p-3 ring-1', meta.tone)}>
              <header className="mb-1 flex items-center justify-between text-xs font-medium">
                <span className="uppercase tracking-wide">{meta.label}</span>
                <time dateTime={entry.occurredAt} className="opacity-70">
                  {formatTime(entry.occurredAt)}
                </time>
              </header>
              {entry.incidentId === null ? (
                <p className="text-sm">{entry.summary}</p>
              ) : (
                <a
                  className="text-sm font-medium underline underline-offset-2"
                  href={`/incidents/${entry.incidentId}`}
                >
                  {entry.summary}
                </a>
              )}
              <p className="mt-1 text-xs opacity-70">
                {entry.actorKind === 'user'
                  ? 'User'
                  : entry.actorKind === 'agent'
                    ? 'Agent'
                    : 'System'}
                {entry.incidentId !== null ? ` · incident ${entry.incidentId.slice(0, 8)}` : ''}
              </p>
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString('en-GB')} ${date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}
