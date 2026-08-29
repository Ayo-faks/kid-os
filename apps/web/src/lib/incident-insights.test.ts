import type { IncidentReportRow } from '@careos/contracts';
import { describe, expect, it } from 'vitest';

import {
  closedMonthDelta,
  deriveRecommendations,
  normalizeMonthlySeries,
  trailingProjection,
} from './incident-insights';

const row = (
  key: string,
  total: number,
  approved = total,
  exported = approved,
): IncidentReportRow => ({ approved, exported, key, label: key, total });

describe('incident insights', () => {
  it('fills missing months with zeros and marks only the generated month partial', () => {
    expect(
      normalizeMonthlySeries([row('2026-04', 2), row('2026-06', 4)], '2026-06-17T09:00:00Z'),
    ).toEqual([
      { ...row('2026-04', 2), partial: false },
      { ...row('2026-05', 0), partial: false },
      { ...row('2026-06', 4), partial: true },
    ]);
  });

  it('excludes the partial month from deltas and projections', () => {
    const points = normalizeMonthlySeries(
      [row('2026-03', 3), row('2026-04', 4), row('2026-05', 5), row('2026-06', 99)],
      '2026-06-17T09:00:00Z',
    );
    expect(closedMonthDelta(points)).toMatchObject({ difference: 1, percent: 25 });
    expect(trailingProjection(points)).toBe(4);
  });

  it('suppresses projections without three closed months and avoids zero-denominator claims', () => {
    const points = normalizeMonthlySeries(
      [row('2026-04', 0), row('2026-05', 2)],
      '2026-06-17T09:00:00Z',
    );
    expect(trailingProjection(points)).toBeNull();
    expect(closedMonthDelta(points)?.percent).toBeNull();
  });

  it('derives transparent approval, export, and sustained-rise recommendations', () => {
    const points = normalizeMonthlySeries(
      [row('2026-02', 1), row('2026-03', 2), row('2026-04', 4)],
      '2026-06-17T09:00:00Z',
    );
    const recommendations = deriveRecommendations([row('behavioural', 10, 6, 4)], points);
    expect(recommendations.map((item) => item.id)).toEqual([
      'approval-coverage',
      'export-coverage',
      'rising-incidents',
    ]);
  });
});
