import {
  CalendarRange,
  ChartNoAxesColumnIncreasing,
  ClipboardCheck,
  FileText,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Menu,
  Settings,
  ShieldCheck,
  UserRound,
  UsersRound,
  Wand2,
} from 'lucide-react';
import { redirect } from 'next/navigation';

import { CareAssistantPanel } from '@/components/care-assistant/Panel';
import { SignOutButton } from '@/components/SignOutButton';
import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';
import {
  APPROVAL_ROLES,
  AUTOMATION_ROLES,
  MATTERMOST_ADMIN_ROLES,
  REPORT_VIEW_ROLES,
  SETTINGS_ROLES,
  hasAnyCareosRole,
} from '@/lib/roles';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/residents', icon: UsersRound, label: 'Residents' },
  { href: '/incidents', icon: ShieldCheck, label: 'Incidents' },
  { href: '/reports', icon: ChartNoAxesColumnIncreasing, label: 'Incident insights' },
  { href: '/handovers', icon: ClipboardCheck, label: 'Handovers' },
  { href: '/comms/email/new', icon: Mail, label: 'Communications' },
  { href: '/rota', icon: CalendarRange, label: 'Rota' },
  { href: '/approvals', icon: Wand2, label: 'Approvals' },
  { href: '/comms/mattermost', icon: MessageSquare, label: 'Mattermost' },
  { href: '/documents', icon: FileText, label: 'Documents' },
  { href: '/settings', icon: Settings, label: 'Settings' },
] as const;

const quickActions = [
  {
    description: 'Summarise a shift and queue follow-ups.',
    href: '/handovers',
    icon: ClipboardCheck,
    label: 'Start handover',
  },
  {
    description: 'Draft an email; sensitive drafts route for review.',
    href: '/comms/email/new',
    icon: Mail,
    label: 'Draft email',
  },
  {
    description: 'Review pending workflow decisions.',
    href: '/approvals',
    icon: Wand2,
    label: 'Review approvals',
  },
  {
    description: 'Analyse coverage gaps and publish the rota.',
    href: '/rota',
    icon: CalendarRange,
    label: 'View rota',
  },
] as const;

interface RotaShiftSummary {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly requiredRole: string;
  readonly minHeadcount: number;
  readonly assignedUserIds: readonly string[];
}

interface RotaOverviewResponse {
  readonly shifts: readonly RotaShiftSummary[];
}

interface ApprovalsResponse {
  readonly items: readonly { readonly status: 'pending' | 'approved' | 'rejected' }[];
}

interface ResidentsSummaryResponse {
  readonly items: readonly { readonly id: string }[];
}

interface IncidentsSummaryResponse {
  readonly items: readonly {
    readonly status:
      | 'draft'
      | 'awaiting_fields'
      | 'awaiting_approval'
      | 'approved'
      | 'exported'
      | 'rejected';
  }[];
}

const OPEN_INCIDENT_STATUSES = new Set(['draft', 'awaiting_fields', 'awaiting_approval']);

type AutomationAction =
  | 'shift.reminder_dispatched'
  | 'shift.handover_due_reminder_dispatched'
  | 'incident.missing_fields_reminder_dispatched'
  | 'safeguarding.weekly_digest_dispatched';

interface RecentAutomationEvent {
  readonly id: string;
  readonly action: AutomationAction;
  readonly occurredAt: string;
}

interface RecentAutomationsResponse {
  readonly events: readonly RecentAutomationEvent[];
}

const AUTOMATION_LABELS: Record<AutomationAction, string> = {
  'incident.missing_fields_reminder_dispatched': 'Incident missing-fields reminder',
  'safeguarding.weekly_digest_dispatched': 'Safeguarding weekly digest',
  'shift.handover_due_reminder_dispatched': 'Handover reminder dispatched',
  'shift.reminder_dispatched': 'Pre-shift reminder dispatched',
};

function formatAutomationTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  });
}

function countMinStaffingGaps(shifts: readonly RotaShiftSummary[]): number {
  return shifts.reduce(
    (count, shift) => count + (shift.assignedUserIds.length < shift.minHeadcount ? 1 : 0),
    0,
  );
}

function pickFeaturedShift(
  shifts: readonly RotaShiftSummary[],
  now: Date,
): RotaShiftSummary | null {
  if (shifts.length === 0) return null;
  const sorted = [...shifts].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  return sorted.find((shift) => new Date(shift.endsAt) >= now) ?? sorted.at(-1) ?? null;
}

function formatShiftWindow(shift: RotaShiftSummary): string {
  const start = new Date(shift.startsAt);
  const end = new Date(shift.endsAt);
  const date = start.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    weekday: 'short',
  });
  const time = (value: Date) =>
    value.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time(start)}–${time(end)}`;
}

export default async function HomePage() {
  const session = await getCareosServerSession();
  if (session === null) {
    redirect('/api/auth/signin?callbackUrl=/');
  }

  const displayName = session.user?.name ?? session.user?.email ?? 'Kid-OS user';
  const canReviewApprovals = hasAnyCareosRole(session.roles, APPROVAL_ROLES);
  const canViewAutomations = hasAnyCareosRole(session.roles, AUTOMATION_ROLES);
  const canManageMattermost = hasAnyCareosRole(session.roles, MATTERMOST_ADMIN_ROLES);
  const canViewReports = hasAnyCareosRole(session.roles, REPORT_VIEW_ROLES);
  const canManageSettings = hasAnyCareosRole(session.roles, SETTINGS_ROLES);
  const visibleNavItems = navItems.filter(
    (item) =>
      (item.href !== '/approvals' || canReviewApprovals) &&
      (item.href !== '/comms/mattermost' || canManageMattermost) &&
      (item.href !== '/reports' || canViewReports) &&
      (item.href !== '/settings' || canManageSettings),
  );
  const visibleQuickActions = quickActions.filter(
    (action) => action.href !== '/approvals' || canReviewApprovals,
  );

  const [rotaResult, approvalsResult, automationsResult, residentsResult, incidentsResult] =
    await Promise.all([
      apiFetch<RotaOverviewResponse>('/rota'),
      canReviewApprovals ? apiFetch<ApprovalsResponse>('/approvals') : Promise.resolve(null),
      canViewAutomations
        ? apiFetch<RecentAutomationsResponse>('/automations/recent?limit=5')
        : Promise.resolve(null),
      apiFetch<ResidentsSummaryResponse>('/residents'),
      apiFetch<IncidentsSummaryResponse>('/incidents'),
    ]);
  const rotaShifts = rotaResult.ok ? rotaResult.data.shifts : [];
  const gapCount = countMinStaffingGaps(rotaShifts);
  const featuredShift = pickFeaturedShift(rotaShifts, new Date());
  const pendingApprovals =
    approvalsResult?.ok === true
      ? approvalsResult.data.items.filter((item) => item.status === 'pending').length
      : null;
  const automationEvents = automationsResult?.ok === true ? automationsResult.data.events : null;
  const residentCount = residentsResult.ok ? residentsResult.data.items.length : null;
  const openIncidentCount = incidentsResult.ok
    ? incidentsResult.data.items.filter((incident) => OPEN_INCIDENT_STATUSES.has(incident.status))
        .length
    : null;

  const summaryCards = [
    {
      label: 'Residents',
      tone: 'bg-cyan-50 text-cyan-900 ring-cyan-100',
      value: residentCount === null ? '—' : String(residentCount),
    },
    {
      label: 'Open incidents',
      tone: 'bg-rose-50 text-rose-900 ring-rose-100',
      value: openIncidentCount === null ? '—' : String(openIncidentCount),
    },
    {
      label: 'Rota gaps',
      tone: 'bg-amber-50 text-amber-900 ring-amber-100',
      value: rotaResult.ok ? String(gapCount) : '—',
    },
    ...(canReviewApprovals
      ? [
          {
            label: 'Approvals pending',
            tone: 'bg-emerald-50 text-emerald-900 ring-emerald-100',
            value: pendingApprovals === null ? '—' : String(pendingApprovals),
          },
        ]
      : []),
  ];

  return (
    <main className="min-h-screen bg-[#f7f4ee] text-slate-950">
      <div className="grid min-h-screen lg:grid-cols-[280px_1fr]">
        <aside className="hidden border-r border-slate-200/80 bg-white/80 px-5 py-6 shadow-sm backdrop-blur lg:block">
          <Brand />
          <Navigation items={visibleNavItems} label="Primary navigation" />
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-[#f7f4ee]/85 px-4 py-4 backdrop-blur md:px-8">
            <div className="flex items-center gap-3">
              <details className="group relative lg:hidden">
                <summary
                  aria-label="Open navigation"
                  className="flex size-10 cursor-pointer list-none items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950 [&::-webkit-details-marker]:hidden"
                  role="button"
                >
                  <Menu className="size-4" aria-hidden="true" />
                </summary>
                <div className="absolute left-0 top-12 z-20 w-64 rounded-md border border-slate-200 bg-white p-2 shadow-lg">
                  <Navigation items={visibleNavItems} label="Mobile navigation" />
                </div>
              </details>

              <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-950 lg:text-slate-600">
                CareOS
              </p>
              <div className="flex items-center gap-2">
                <div className="flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm">
                  <UserRound className="size-4" aria-hidden="true" />
                  <span className="sr-only sm:not-sr-only sm:max-w-40 sm:truncate">
                    Signed in as {displayName}
                  </span>
                </div>
                <SignOutButton />
              </div>
            </div>
          </header>

          <div className="flex-1 px-4 py-6 md:px-8 md:py-8">
            <div className="mb-6">
              <p className="text-sm font-medium text-slate-600">Today</p>
              <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">Dashboard</h1>
            </div>

            <div
              className={cn(
                'grid gap-4 sm:grid-cols-2',
                canReviewApprovals ? 'xl:grid-cols-4' : 'xl:grid-cols-3',
              )}
            >
              {summaryCards.map((card) => (
                <section
                  className={cn('rounded-md bg-white p-4 shadow-sm ring-1', card.tone)}
                  key={card.label}
                >
                  <p className="text-sm font-medium">{card.label}</p>
                  <p className="mt-3 text-3xl font-semibold tracking-normal">{card.value}</p>
                </section>
              ))}
            </div>

            <section aria-labelledby="quick-actions-heading" className="mt-6">
              <h2 id="quick-actions-heading" className="sr-only">
                Quick actions
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {visibleQuickActions.map((action) => (
                  <li key={action.label}>
                    <a
                      className="flex h-full items-start gap-3 rounded-md border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
                      href={action.href}
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-slate-950 text-white">
                        <action.icon className="size-4" aria-hidden="true" />
                      </span>
                      <span>
                        <span className="block text-sm font-semibold">{action.label}</span>
                        <span className="mt-1 block text-xs text-slate-600">
                          {action.description}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>

            <section className="mt-6 rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-600">Today&apos;s rota</p>
                  <h2 className="text-base font-semibold">
                    {featuredShift === null
                      ? 'No shifts scheduled'
                      : `Next shift · ${formatShiftWindow(featuredShift)}`}
                  </h2>
                </div>
                <div className="flex items-center gap-3">
                  {rotaResult.ok ? (
                    <span
                      className={cn(
                        'rounded-md px-2 py-1 text-xs font-semibold ring-1',
                        gapCount === 0
                          ? 'bg-emerald-50 text-emerald-900 ring-emerald-100'
                          : 'bg-amber-50 text-amber-900 ring-amber-100',
                      )}
                      data-testid="rota-gap-badge"
                    >
                      {gapCount === 0
                        ? 'No gaps detected'
                        : `${gapCount} ${gapCount === 1 ? 'gap needs' : 'gaps need'} filling`}
                    </span>
                  ) : (
                    <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">
                      Rota unavailable
                    </span>
                  )}
                  <a
                    className="rounded-md bg-slate-950 px-3 py-2 text-xs font-semibold text-white"
                    href="/rota"
                  >
                    Open rota editor
                  </a>
                </div>
              </div>
              {featuredShift !== null ? (
                <p className="mt-3 text-sm text-slate-700">
                  Requires {featuredShift.minHeadcount}{' '}
                  {featuredShift.requiredRole.replace('_', ' ')};{' '}
                  {featuredShift.assignedUserIds.length} assigned.
                </p>
              ) : null}
            </section>

            {canViewAutomations ? (
              <section
                aria-labelledby="automations-heading"
                className="mt-6 rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200"
                data-testid="automations-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-600">Automations</p>
                    <h2 id="automations-heading" className="text-base font-semibold">
                      Recent scheduled dispatches
                    </h2>
                  </div>
                  <span
                    className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600"
                    data-testid="automations-count"
                  >
                    {automationEvents === null
                      ? 'Unavailable'
                      : `${automationEvents.length} event${automationEvents.length === 1 ? '' : 's'}`}
                  </span>
                </div>
                {automationEvents !== null && automationEvents.length > 0 ? (
                  <ul className="mt-4 grid gap-2" data-testid="automations-list">
                    {automationEvents.map((event) => (
                      <li
                        className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm"
                        key={event.id}
                      >
                        <span className="font-medium">{AUTOMATION_LABELS[event.action]}</span>
                        <span className="text-xs text-slate-600">
                          {formatAutomationTime(event.occurredAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-slate-600">
                    {automationEvents === null
                      ? 'The automations feed is temporarily unavailable.'
                      : 'No scheduled automations have run yet for this home.'}
                  </p>
                )}
              </section>
            ) : null}

            <div className="mt-6 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
              <section className="rounded-md bg-white p-5 shadow-sm ring-1 ring-slate-200">
                <div className="mb-5 flex items-center justify-between">
                  <h2 className="text-base font-semibold">Today&apos;s timeline</h2>
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">
                    0 items
                  </span>
                </div>
                <div className="grid gap-3">
                  {['07:30', '12:00', '17:30'].map((time) => (
                    <div
                      className="grid min-h-16 grid-cols-[64px_1fr] rounded-md border border-dashed border-slate-200 bg-slate-50/70 p-3"
                      key={time}
                    >
                      <span className="text-sm font-medium text-slate-600">{time}</span>
                      <span className="text-sm text-slate-600">No entries</span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="rounded-md bg-slate-950 text-white shadow-sm">
                <CareAssistantPanel />
              </section>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Brand() {
  return (
    <div className="mb-8 flex items-center gap-3">
      <div className="flex size-10 items-center justify-center rounded-md bg-slate-950 text-sm font-semibold text-white">
        KO
      </div>
      <div>
        <p className="text-sm font-semibold leading-none">Kid-OS</p>
        <p className="mt-1 text-xs text-slate-600">Residential care</p>
      </div>
    </div>
  );
}

function Navigation({
  items,
  label,
}: {
  readonly items: readonly (typeof navItems)[number][];
  readonly label: string;
}) {
  return (
    <nav aria-label={label} className="space-y-1">
      {items.map((item, index) => (
        <a
          aria-current={index === 0 ? 'page' : undefined}
          className={cn(
            'flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-950',
            index === 0 && 'bg-slate-950 text-white hover:bg-slate-950 hover:text-white',
          )}
          href={item.href}
          key={item.label}
        >
          <item.icon className="size-4" aria-hidden="true" />
          {item.label}
        </a>
      ))}
    </nav>
  );
}
