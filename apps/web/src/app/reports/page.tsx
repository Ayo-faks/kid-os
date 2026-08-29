import type { IncidentReportResponse, IncidentReportRow } from '@careos/contracts';
import { Download, Filter } from 'lucide-react';
import { redirect } from 'next/navigation';

import { SignOutButton } from '@/components/SignOutButton';
import { apiFetch } from '@/lib/api';
import { getCareosServerSession } from '@/lib/auth';
import {
  closedMonthDelta,
  deriveRecommendations,
  normalizeMonthlySeries,
  trailingProjection,
  type MonthlyIncidentPoint,
} from '@/lib/incident-insights';
import { REPORT_EXPORT_ROLES, REPORT_VIEW_ROLES, hasAnyCareosRole } from '@/lib/roles';

interface ReportSearchParams {
  readonly from?: string;
  readonly through?: string;
}

interface ReportsPageProps {
  readonly searchParams: Promise<ReportSearchParams>;
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const resolvedSearchParams = await searchParams;
  const session = await getCareosServerSession();
  if (session === null) redirect('/api/auth/signin?callbackUrl=/reports');
  if (!hasAnyCareosRole(session.roles, REPORT_VIEW_ROLES)) {
    return (
      <ReportShell>
        <section className="border-t border-slate-200 py-8">
          <h2 className="text-lg font-semibold">Reports access is restricted</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Incident insights are available to signed-in care staff.
          </p>
        </section>
      </ReportShell>
    );
  }
  const canExportReports = hasAnyCareosRole(session.roles, REPORT_EXPORT_ROLES);

  const filters = reportFilters(resolvedSearchParams);
  const suffix = filters.apiQuery === '' ? '' : `?${filters.apiQuery}`;
  const [byType, byHome, byMonth] = await Promise.all([
    apiFetch<IncidentReportResponse>(`/reports/incidents/by-type${suffix}`),
    apiFetch<IncidentReportResponse>(`/reports/incidents/by-home${suffix}`),
    apiFetch<IncidentReportResponse>(`/reports/incidents/by-month${suffix}`),
  ]);
  const failed = [byType, byHome, byMonth].find((result) => !result.ok);

  if (failed !== undefined && !failed.ok) {
    return (
      <ReportShell>
        <section className="border-t border-slate-200 py-8">
          <h2 className="text-lg font-semibold">
            {failed.status === 403 ? 'Reports access is restricted' : 'Reports unavailable'}
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            {failed.status === 403
              ? 'Incident insights are available to signed-in care staff.'
              : `Kid-OS could not load incident reports (HTTP ${failed.status}). Try again shortly.`}
          </p>
        </section>
      </ReportShell>
    );
  }

  if (!byType.ok || !byHome.ok || !byMonth.ok) return null;
  const monthly = normalizeMonthlySeries(byMonth.data.rows, byMonth.data.generatedAt);
  const projection = trailingProjection(monthly);
  const delta = closedMonthDelta(monthly);
  const total = sumRows(byType.data.rows, 'total');
  const approved = sumRows(byType.data.rows, 'approved');
  const exported = sumRows(byType.data.rows, 'exported');
  const recommendations = deriveRecommendations(byType.data.rows, monthly);
  const csvQuery = filters.csvQuery === '' ? '' : `&${filters.csvQuery}`;

  return (
    <ReportShell>
      <form className="grid gap-3 border-y border-slate-200 py-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          From
          <input
            className="h-10 rounded-md border border-slate-300 bg-white px-3 text-slate-950"
            defaultValue={filters.from ?? ''}
            name="from"
            type="date"
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-700">
          Through
          <input
            className="h-10 rounded-md border border-slate-300 bg-white px-3 text-slate-950"
            defaultValue={filters.through ?? ''}
            name="through"
            type="date"
          />
        </label>
        <button
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white"
          type="submit"
        >
          <Filter className="size-4" aria-hidden="true" /> Apply dates
        </button>
      </form>

      <section aria-labelledby="summary-heading" className="py-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-slate-600">Selected period</p>
            <h2 id="summary-heading" className="text-lg font-semibold">
              Incident summary
            </h2>
          </div>
          <p className="text-xs text-slate-600">
            Generated {new Date(byType.data.generatedAt).toLocaleString('en-GB')}
          </p>
        </div>
        <dl className="mt-4 grid gap-px overflow-hidden rounded-md bg-slate-200 ring-1 ring-slate-200 sm:grid-cols-4">
          <Metric label="Incidents" value={String(total)} />
          <Metric label="Recorded approved" value={String(approved)} />
          <Metric label="Recorded exported" value={String(exported)} />
          <Metric
            label="Approval coverage"
            value={total === 0 ? '—' : `${Math.round((approved / total) * 100)}%`}
          />
        </dl>
      </section>

      <section aria-labelledby="monthly-heading" className="border-t border-slate-200 py-7">
        <SectionHeading
          csvHref={
            canExportReports ? `/api/reports/incidents/export.csv?groupBy=month${csvQuery}` : null
          }
          id="monthly-heading"
          title="Monthly trend"
        />
        <div className="mt-4 grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
          <MonthlyTrend points={monthly} />
          <dl className="grid content-start gap-px overflow-hidden rounded-md bg-slate-200 ring-1 ring-slate-200">
            <Metric
              label="Latest closed-month change"
              value={
                delta === null
                  ? 'Not enough data'
                  : `${delta.difference > 0 ? '+' : ''}${delta.difference}${delta.percent === null ? '' : ` (${Math.round(delta.percent)}%)`}`
              }
            />
            <Metric
              label="Next-month projection"
              value={projection === null ? 'Not enough closed months' : projection.toFixed(1)}
            />
          </dl>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          Projection is the average of the prior three closed months. Month-to-date data is shown
          but never used in the projection.
        </p>
      </section>

      <section aria-labelledby="type-heading" className="border-t border-slate-200 py-7">
        <SectionHeading
          csvHref={
            canExportReports ? `/api/reports/incidents/export.csv?groupBy=type${csvQuery}` : null
          }
          id="type-heading"
          title="Incidents by type"
        />
        <ReportBars rows={byType.data.rows} />
      </section>

      <section aria-labelledby="home-heading" className="border-t border-slate-200 py-7">
        <SectionHeading
          csvHref={
            canExportReports ? `/api/reports/incidents/export.csv?groupBy=home${csvQuery}` : null
          }
          id="home-heading"
          title="Incidents by home"
        />
        <ReportBars rows={byHome.data.rows} />
      </section>

      <section aria-labelledby="actions-heading" className="border-t border-slate-200 py-7">
        <p className="text-sm font-medium text-cyan-800">Advisory only</p>
        <h2 id="actions-heading" className="text-lg font-semibold">
          Recommended reviews
        </h2>
        {recommendations.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">
            No rule-based review prompts were detected for this period.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
            {recommendations.map((item) => (
              <li className="grid gap-2 py-4 sm:grid-cols-[1fr_auto] sm:items-center" key={item.id}>
                <div>
                  <h3 className="text-sm font-semibold">{item.title}</h3>
                  <p className="mt-1 text-sm text-slate-600">{item.rationale}</p>
                </div>
                <a className="text-sm font-semibold text-cyan-800 underline" href={item.href}>
                  Review
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </ReportShell>
  );
}

function ReportShell({ children }: { readonly children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[#f7f4ee] px-4 py-6 text-slate-950 md:px-8 md:py-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-600">Reporting</p>
            <h1 className="text-2xl font-semibold md:text-3xl">Incident insights</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              Trends, approval coverage, exports, and transparent review prompts.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a className="text-sm font-semibold text-cyan-800 underline" href="/">
              Back to dashboard
            </a>
            <SignOutButton />
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="bg-white p-4">
      <dt className="text-xs font-medium text-slate-600">{label}</dt>
      <dd className="mt-2 text-xl font-semibold">{value}</dd>
    </div>
  );
}

function SectionHeading({
  csvHref,
  id,
  title,
}: {
  readonly csvHref: string | null;
  readonly id: string;
  readonly title: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold" id={id}>
        {title}
      </h2>
      {csvHref === null ? null : (
        <a
          className="inline-flex items-center gap-2 text-sm font-semibold text-cyan-800 underline"
          href={csvHref}
        >
          <Download className="size-4" aria-hidden="true" /> Download CSV
        </a>
      )}
    </div>
  );
}

function ReportBars({ rows }: { readonly rows: readonly IncidentReportRow[] }) {
  const max = Math.max(...rows.map((row) => row.total), 1);
  if (rows.length === 0) return <p className="mt-4 text-sm text-slate-600">No incidents found.</p>;
  return (
    <ul className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
      {rows.map((row) => (
        <li
          className="grid gap-2 py-4 md:grid-cols-[180px_1fr_180px] md:items-center"
          key={row.key}
        >
          <span className="truncate text-sm font-medium">{row.label}</span>
          <div
            aria-label={`${row.label}: ${row.total} total, ${row.approved} approved, ${row.exported} exported`}
            className="h-3 overflow-hidden rounded-sm bg-slate-200"
            role="img"
          >
            <div className="h-full bg-cyan-700" style={{ width: `${(row.total / max) * 100}%` }} />
          </div>
          <span className="text-xs text-slate-600">
            {row.total} total · {row.approved} approved · {row.exported} exported
          </span>
        </li>
      ))}
    </ul>
  );
}

function MonthlyTrend({ points }: { readonly points: readonly MonthlyIncidentPoint[] }) {
  const visible = points.slice(-12);
  const max = Math.max(...visible.map((point) => point.total), 1);
  const width = 720;
  const height = 220;
  const gap = 12;
  const columnWidth =
    visible.length === 0 ? 0 : (width - gap * (visible.length + 1)) / visible.length;
  return (
    <div
      aria-label="Scrollable monthly incident chart and table"
      className="min-w-0 overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950"
      role="region"
      tabIndex={0}
    >
      <svg
        aria-labelledby="monthly-chart-title monthly-chart-description"
        className="h-auto min-w-[620px] w-full"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <title id="monthly-chart-title">Incidents by month</title>
        <desc id="monthly-chart-description">
          Monthly incident totals. Hatched columns represent partial month-to-date values.
        </desc>
        <defs>
          <pattern height="8" id="partial-month" patternUnits="userSpaceOnUse" width="8">
            <rect fill="#0e7490" height="8" width="8" />
            <path d="M-2 2L2-2M0 8L8 0M6 10L10 6" stroke="#67e8f9" strokeWidth="2" />
          </pattern>
        </defs>
        <line stroke="#cbd5e1" x1="0" x2={width} y1="180" y2="180" />
        {visible.map((point, index) => {
          const barHeight = (point.total / max) * 145;
          const x = gap + index * (columnWidth + gap);
          return (
            <g key={point.key}>
              <rect
                fill={point.partial ? 'url(#partial-month)' : '#0e7490'}
                height={barHeight}
                rx="2"
                width={columnWidth}
                x={x}
                y={180 - barHeight}
              />
              <text
                fill="#334155"
                fontSize="11"
                textAnchor="middle"
                x={x + columnWidth / 2}
                y="202"
              >
                {point.key.slice(5)}
              </text>
              <text
                fill="#0f172a"
                fontSize="11"
                fontWeight="600"
                textAnchor="middle"
                x={x + columnWidth / 2}
                y={Math.max(20, 174 - barHeight)}
              >
                {point.total}
              </text>
            </g>
          );
        })}
      </svg>
      <table className="mt-3 w-full min-w-[620px] text-left text-xs">
        <caption className="sr-only">Monthly incident counts</caption>
        <thead>
          <tr className="border-b border-slate-200 text-slate-600">
            <th className="py-2 font-medium" scope="col">
              Month
            </th>
            <th className="py-2 font-medium" scope="col">
              Total
            </th>
            <th className="py-2 font-medium" scope="col">
              Approved
            </th>
            <th className="py-2 font-medium" scope="col">
              Exported
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((point) => (
            <tr className="border-b border-slate-200" key={point.key}>
              <th className="py-2 font-medium" scope="row">
                {point.label}
                {point.partial ? ' (month to date)' : ''}
              </th>
              <td>{point.total}</td>
              <td>{point.approved}</td>
              <td>{point.exported}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function reportFilters(searchParams: ReportSearchParams): {
  readonly apiQuery: string;
  readonly csvQuery: string;
  readonly from?: string;
  readonly through?: string;
} {
  const from = validDateInput(searchParams?.from) ? searchParams?.from : undefined;
  const through = validDateInput(searchParams?.through) ? searchParams?.through : undefined;
  const query = new URLSearchParams();
  if (from !== undefined) query.set('from', `${from}T00:00:00.000Z`);
  if (through !== undefined) query.set('to', nextUtcDay(through));
  const serialized = query.toString();
  return { apiQuery: serialized, csvQuery: serialized, from, through };
}

function validDateInput(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
  );
}

function nextUtcDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}

function sumRows(
  rows: readonly IncidentReportRow[],
  field: 'approved' | 'exported' | 'total',
): number {
  return rows.reduce((sum, row) => sum + row[field], 0);
}
