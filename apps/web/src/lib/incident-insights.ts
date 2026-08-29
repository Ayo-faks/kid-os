import type { IncidentReportRow } from '@careos/contracts';

export interface MonthlyIncidentPoint extends IncidentReportRow {
  readonly partial: boolean;
}

export interface ClosedMonthDelta {
  readonly currentKey: string;
  readonly difference: number;
  readonly percent: number | null;
  readonly previousKey: string;
}

export interface IncidentRecommendation {
  readonly href: string;
  readonly id: 'approval-coverage' | 'export-coverage' | 'rising-incidents';
  readonly rationale: string;
  readonly title: string;
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function normalizeMonthlySeries(
  rows: readonly IncidentReportRow[],
  generatedAt: string,
): readonly MonthlyIncidentPoint[] {
  const generatedMonth = monthKey(new Date(generatedAt));
  const byMonth = new Map(
    rows.filter((row) => MONTH_KEY.test(row.key)).map((row) => [row.key, row]),
  );
  const keys = [...byMonth.keys()].sort();
  const first = keys[0];
  const last = keys.at(-1);
  if (first === undefined || last === undefined) return [];

  const normalized: MonthlyIncidentPoint[] = [];
  for (let key = first; key <= last; key = nextMonth(key)) {
    const row = byMonth.get(key);
    normalized.push({
      approved: row?.approved ?? 0,
      exported: row?.exported ?? 0,
      key,
      label: row?.label ?? key,
      partial: key === generatedMonth,
      total: row?.total ?? 0,
    });
  }
  return normalized;
}

export function closedMonthDelta(points: readonly MonthlyIncidentPoint[]): ClosedMonthDelta | null {
  const closed = points.filter((point) => !point.partial).slice(-2);
  const previous = closed[0];
  const current = closed[1];
  if (previous === undefined || current === undefined) return null;
  return {
    currentKey: current.key,
    difference: current.total - previous.total,
    percent:
      previous.total === 0 ? null : ((current.total - previous.total) / previous.total) * 100,
    previousKey: previous.key,
  };
}

export function trailingProjection(points: readonly MonthlyIncidentPoint[]): number | null {
  const closed = points.filter((point) => !point.partial).slice(-3);
  if (closed.length < 3) return null;
  return closed.reduce((sum, point) => sum + point.total, 0) / closed.length;
}

export function deriveRecommendations(
  aggregateRows: readonly IncidentReportRow[],
  monthlyPoints: readonly MonthlyIncidentPoint[],
): readonly IncidentRecommendation[] {
  const totals = aggregateRows.reduce(
    (sum, row) => ({
      approved: sum.approved + row.approved,
      exported: sum.exported + row.exported,
      total: sum.total + row.total,
    }),
    { approved: 0, exported: 0, total: 0 },
  );
  const recommendations: IncidentRecommendation[] = [];

  if (totals.total > 0 && (totals.total - totals.approved) / totals.total >= 0.2) {
    recommendations.push({
      href: '/approvals',
      id: 'approval-coverage',
      rationale: `${totals.total - totals.approved} of ${totals.total} incidents are not recorded as approved.`,
      title: 'Review incident approvals',
    });
  }

  if (totals.approved > totals.exported) {
    recommendations.push({
      href: '/incidents',
      id: 'export-coverage',
      rationale: `${totals.approved - totals.exported} approved incident${totals.approved - totals.exported === 1 ? '' : 's'} do not have a recorded export.`,
      title: 'Review export coverage',
    });
  }

  const latestClosed = monthlyPoints.filter((point) => !point.partial).slice(-3);
  const first = latestClosed[0];
  const middle = latestClosed[1];
  const last = latestClosed[2];
  if (
    first !== undefined &&
    middle !== undefined &&
    last !== undefined &&
    first.total < middle.total &&
    middle.total < last.total &&
    last.total - first.total >= 2
  ) {
    recommendations.push({
      href: '/rota',
      id: 'rising-incidents',
      rationale: `Closed-month incidents rose from ${first.total} in ${first.label} to ${last.total} in ${last.label}.`,
      title: 'Review staffing and care-plan patterns',
    });
  }

  return recommendations;
}

function monthKey(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('generatedAt must be a valid ISO date.');
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMonth(key: string): string {
  const match = MONTH_KEY.exec(key);
  if (match === null) throw new Error(`Invalid month key: ${key}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
}
