import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rotaMocks = vi.hoisted(() => ({
  analyzeRota: vi.fn(),
  loadRotaContext: vi.fn(),
  narrateRotaAnalysis: vi.fn(),
}));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/rota.js', () => rotaMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import { processRotaAnalyzeCommandActivity } from './rota-analyze.activities.js';

const context = new ActivityContext('rota-analyze-test', 1);
const input = {
  actor: {
    correlationId: 'corr-rota-analyze',
    kind: 'user' as const,
    userId: '55555555-5555-4555-8555-555555555555',
  },
  analysisId: '44444444-4444-4444-8444-444444444444',
  commandId: '66666666-6666-4666-8666-666666666666',
  homeId: '22222222-2222-4222-8222-222222222222',
  requestedByUserId: '55555555-5555-4555-8555-555555555555',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const payload = {
  actor: input.actor,
  correlationId: input.actor.correlationId,
  homeId: input.homeId,
  periodEnd: '2026-07-25T00:00:00.000Z',
  periodStart: '2026-07-18T00:00:00.000Z',
  requestedByUserId: input.requestedByUserId,
  tenantId: input.tenantId,
};
const shift = {
  assignedUserIds: [],
  endsAt: '2026-07-18T15:00:00.000Z',
  id: '33333333-3333-4333-8333-333333333333',
  minHeadcount: 2,
  requiredRole: 'support_worker',
  startsAt: '2026-07-18T07:00:00.000Z',
};

describe('Durable Rota Analyze command activity', () => {
  beforeEach(() => {
    rotaMocks.loadRotaContext.mockResolvedValue({ rules: [], shifts: [shift], staff: [] });
    rotaMocks.analyzeRota.mockResolvedValue({
      gaps: [
        {
          detail: 'Two staff required.',
          kind: 'min_staffing',
          ruleId: null,
          ruleName: 'Minimum staffing',
          severity: 'high',
          shiftId: shift.id,
        },
      ],
      proposals: [
        {
          addUserIds: ['77777777-7777-4777-8777-777777777777'],
          reason: 'Covers minimum staffing.',
          removeUserIds: [],
          resolvedGapKinds: ['min_staffing'],
          shiftId: shift.id,
        },
      ],
    });
    rotaMocks.narrateRotaAnalysis.mockResolvedValue({
      narration: 'One private rota gap needs manager review.',
      promptHash: 'prompt-hash',
      refused: false,
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('persists the full analysis while returning only its ID and status', async () => {
    const query = useQueryResults([
      commandRow('pending'),
      emptyResult(),
      emptyResult(),
      emptyResult(),
      emptyResult(),
    ]);

    const result = await processRotaAnalyzeCommandActivity(context, input);

    expect(result).toEqual({ analysisId: input.analysisId, status: 'completed' });
    const persistedParameters: unknown = query.mock.calls[2]?.[1];
    if (!Array.isArray(persistedParameters)) throw new Error('Missing persisted parameters.');
    const persistedJson = String(persistedParameters[5]);
    expect(persistedJson).toContain('One private rota gap needs manager review.');
    expect(persistedJson).toContain('Covers minimum staffing.');
    expect(JSON.stringify(result)).not.toContain('manager review');
    expect(JSON.stringify(result)).not.toContain('reason');
  });

  it('rehydrates an applied result without rerunning analysis or Hermes', async () => {
    useQueryResults([commandRow('applied'), { rowCount: 1, rows: [{ status: 'completed' }] }]);

    await expect(processRotaAnalyzeCommandActivity(context, input)).resolves.toEqual({
      analysisId: input.analysisId,
      status: 'completed',
    });
    expect(rotaMocks.loadRotaContext).not.toHaveBeenCalled();
    expect(rotaMocks.narrateRotaAnalysis).not.toHaveBeenCalled();
  });

  it('stores detailed provider failure but throws only a generic scheduler error', async () => {
    const query = useQueryResults([commandRow('pending'), emptyResult(), emptyResult()]);
    rotaMocks.narrateRotaAnalysis.mockRejectedValue(
      new Error('Hermes included private staff narrative'),
    );

    await expect(processRotaAnalyzeCommandActivity(context, input)).rejects.toThrow(
      'Rota analysis command processing failed.',
    );
    expect(query.mock.calls.at(-1)?.[1]).toContain('Hermes included private staff narrative');
  });
});

function commandRow(status: 'pending' | 'processing' | 'applied' | 'failed') {
  return { rowCount: 1, rows: [{ payload, status }] };
}

function emptyResult() {
  return { rowCount: 1, rows: [] };
}

function useQueryResults(
  results: Array<{ readonly rowCount: number; readonly rows: readonly unknown[] }>,
) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  withTenantContextMock.mockImplementation(
    (_context: unknown, callback: (client: { query: typeof query }) => Promise<unknown>) =>
      callback({ query }),
  );
  return query;
}
