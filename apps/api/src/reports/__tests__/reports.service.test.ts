import { describe, expect, it } from 'vitest';

import { renderReportCsv } from '../reports.service.js';

describe('renderReportCsv', () => {
  it('renders header + rows with simple values', () => {
    const csv = renderReportCsv({
      generatedAt: '2026-05-18T00:00:00.000Z',
      groupBy: 'type',
      rows: [
        { approved: 2, exported: 1, key: 'fall', label: 'fall', total: 5 },
        { approved: 0, exported: 0, key: 'medication', label: 'medication', total: 3 },
      ],
    });
    expect(csv).toBe(
      [
        'key,label,total,approved,exported',
        'fall,fall,5,2,1',
        'medication,medication,3,0,0',
        '',
      ].join('\n'),
    );
  });

  it('escapes commas, quotes, and newlines in CSV fields', () => {
    const csv = renderReportCsv({
      generatedAt: '2026-05-18T00:00:00.000Z',
      groupBy: 'home',
      rows: [
        {
          approved: 1,
          exported: 0,
          key: 'home-a',
          label: 'Acorn, "Acme" Home\nMain',
          total: 4,
        },
      ],
    });
    expect(csv).toContain('"Acorn, ""Acme"" Home\nMain"');
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('emits a header-only CSV for empty reports', () => {
    expect(
      renderReportCsv({
        generatedAt: '2026-05-18T00:00:00.000Z',
        groupBy: 'month',
        rows: [],
      }),
    ).toBe('key,label,total,approved,exported\n');
  });
});
