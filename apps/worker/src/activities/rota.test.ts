import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());
const callHermesToolMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withTenantContext: withTenantContextMock,
}));

vi.mock('./hermes.js', () => ({
  callHermesTool: callHermesToolMock,
}));

import { narrateRotaAnalysis, publishRota } from './rota.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const publicationId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const shiftId = '55555555-5555-4555-8555-555555555555';

const baseInput = {
  actor: { correlationId: 'corr-test', kind: 'user' as const, userId },
  homeId,
  note: 'go',
  periodEnd: '2025-01-13T00:00:00.000Z',
  periodStart: '2025-01-06T00:00:00.000Z',
  publicationId,
  publishedByUserId: userId,
  shiftIds: [shiftId],
  tenantId,
  workflowId: 'rota-publish-test-1',
};

describe('publishRota', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a publication and returns published assignment ids', async () => {
    const query = mockTenantClient([
      { rows: [], rowCount: 0 },
      { rows: [{ id: 'assignment-1' }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    const result = await publishRota(baseInput);
    expect(result).toEqual({
      publicationId,
      publishedAssignmentIds: ['assignment-1'],
      status: 'published',
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[0]).toContain('INSERT INTO core.rota_publications');
  });

  it('is idempotent: a second invocation for the same workflowId returns the existing row without writing', async () => {
    const query = mockTenantClient([
      {
        rows: [{ id: publicationId, assignment_ids: ['assignment-1'], status: 'published' }],
        rowCount: 1,
      },
    ]);

    await expect(publishRota(baseInput)).resolves.toEqual({
      publicationId,
      publishedAssignmentIds: ['assignment-1'],
      status: 'published',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('narrateRotaAnalysis', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const narrateInput = {
    correlationId: 'corr-narrate',
    gaps: [
      {
        detail: 'Shift needs 2 support_worker on duty; currently 1.',
        kind: 'min_staffing' as const,
        ruleId: 'rule-1',
        ruleName: 'Minimum support workers',
        severity: 'high' as const,
        shiftId,
      },
    ],
    homeId,
    periodEnd: '2025-01-13T00:00:00.000Z',
    periodStart: '2025-01-06T00:00:00.000Z',
    proposals: [
      {
        addUserIds: [userId],
        reason: 'covers minimum',
        removeUserIds: [],
        resolvedGapKinds: ['min_staffing' as const],
        shiftId,
      },
    ],
    shifts: [
      {
        assignedUserIds: [],
        endsAt: '2025-01-06T15:00:00.000Z',
        id: shiftId,
        minHeadcount: 2,
        requiredRole: 'support_worker',
        startsAt: '2025-01-06T07:00:00.000Z',
      },
    ],
    tenantId,
  };

  it('short-circuits without calling Hermes when there are no gaps or proposals', async () => {
    const result = await narrateRotaAnalysis({
      ...narrateInput,
      gaps: [],
      proposals: [],
    });
    expect(callHermesToolMock).not.toHaveBeenCalled();
    expect(result.narration).toBe('No rota gaps detected for the selected period.');
    expect(result.refused).toBe(false);
  });

  it('propagates Hermes refusal by blanking narration and surfacing refused:true', async () => {
    callHermesToolMock.mockResolvedValueOnce({
      narration: 'should-be-discarded',
      refused: true,
    });

    const result = await narrateRotaAnalysis(narrateInput);
    expect(callHermesToolMock).toHaveBeenCalledTimes(1);
    expect(result.refused).toBe(true);
    expect(result.narration).toBe('');
  });

  it('returns trimmed narration on the happy path', async () => {
    callHermesToolMock.mockResolvedValueOnce({
      narration: '  Coverage gap on the morning shift.  ',
      refused: false,
    });

    const result = await narrateRotaAnalysis(narrateInput);
    expect(result.refused).toBe(false);
    expect(result.narration).toBe('Coverage gap on the morning shift.');
  });
});

function mockTenantClient(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>();
  for (const result of results) {
    query.mockResolvedValueOnce(result);
  }

  withTenantContextMock.mockImplementation(
    (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) =>
      callback({ query } as unknown as PoolClient),
  );
  return query;
}
