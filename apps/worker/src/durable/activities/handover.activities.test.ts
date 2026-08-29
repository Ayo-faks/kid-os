import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handoverMocks = vi.hoisted(() => ({
  persistHandover: vi.fn(),
  summarizeHandover: vi.fn(),
  validateHandover: vi.fn(),
}));
const novuMocks = vi.hoisted(() => ({ dispatchHandoverNotifications: vi.fn() }));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/handovers.js', () => handoverMocks);
vi.mock('../../activities/novu.js', () => novuMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import { processHandoverCommandActivity } from './handover.activities.js';

const context = new ActivityContext('handover-test', 1);
const input = {
  actor: {
    correlationId: 'corr-handover',
    kind: 'user' as const,
    userId: '55555555-5555-4555-8555-555555555555',
  },
  authorUserId: '55555555-5555-4555-8555-555555555555',
  commandId: '66666666-6666-4666-8666-666666666666',
  handoverId: '44444444-4444-4444-8444-444444444444',
  homeId: '22222222-2222-4222-8222-222222222222',
  shiftId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const payload = {
  authorUserId: input.authorUserId,
  correlationId: input.actor.correlationId,
  freeText: 'Private shift narrative requiring a morning check-in.',
  handoverId: input.handoverId,
  homeId: input.homeId,
  shiftId: input.shiftId,
  tenantId: input.tenantId,
  transcriptObjectKey: 'tenants/t/handovers/transcript.wav',
};

describe('Durable Handover command activity', () => {
  beforeEach(() => {
    handoverMocks.summarizeHandover.mockResolvedValue({
      confidence: 0.9,
      formData: { narrative: payload.freeText, shiftId: input.shiftId },
      missingMandatory: [],
      promptHash: 'prompt-hash',
      summary: 'One morning check-in is required.',
    });
    handoverMocks.validateHandover.mockResolvedValue({
      errors: [],
      missingMandatory: [],
      valid: true,
    });
    handoverMocks.persistHandover.mockResolvedValue({
      assigneeUserIds: ['77777777-7777-4777-8777-777777777777'],
      handoverId: input.handoverId,
      nextShiftId: '88888888-8888-4888-8888-888888888888',
      taskIds: ['99999999-9999-4999-8999-999999999999'],
    });
    novuMocks.dispatchHandoverNotifications.mockResolvedValue({
      dispatched: true,
      outboxId: input.handoverId,
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('resolves prose from Postgres and returns only IDs plus status', async () => {
    useQueryResults([commandRow('pending'), emptyResult(), emptyResult(), emptyResult()]);

    const result = await processHandoverCommandActivity(context, input);

    expect(handoverMocks.summarizeHandover).toHaveBeenCalledWith(
      expect.objectContaining({
        freeText: payload.freeText,
        transcriptObjectKey: payload.transcriptObjectKey,
      }),
    );
    expect(handoverMocks.persistHandover).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceText: payload.freeText,
        summary: 'One morning check-in is required.',
      }),
    );
    expect(result).toEqual({
      handoverId: input.handoverId,
      missingMandatory: [],
      status: 'completed',
      taskIds: ['99999999-9999-4999-8999-999999999999'],
    });
    expect(JSON.stringify(result)).not.toContain('Private shift narrative');
    expect(JSON.stringify(result)).not.toContain('transcript.wav');
  });

  it('rehydrates task IDs after a lost activity acknowledgement without calling Hermes twice', async () => {
    useQueryResults([
      commandRow('applied'),
      { rows: [{ id: input.handoverId }], rowCount: 1 },
      {
        rows: [{ task_id: '99999999-9999-4999-8999-999999999999' }],
        rowCount: 1,
      },
    ]);

    await expect(processHandoverCommandActivity(context, input)).resolves.toMatchObject({
      status: 'completed',
      taskIds: ['99999999-9999-4999-8999-999999999999'],
    });
    expect(handoverMocks.summarizeHandover).not.toHaveBeenCalled();
  });

  it('persists deterministic validation failure with field names only', async () => {
    useQueryResults([commandRow('pending'), emptyResult(), emptyResult(), emptyResult()]);
    handoverMocks.validateHandover.mockResolvedValue({
      errors: [{ message: 'is required', path: '/endedAt' }],
      missingMandatory: ['endedAt'],
      valid: false,
    });

    await expect(processHandoverCommandActivity(context, input)).resolves.toEqual({
      handoverId: input.handoverId,
      missingMandatory: ['endedAt'],
      outcomeCode: 'validation-failed',
      status: 'failed',
      taskIds: [],
    });
    expect(handoverMocks.persistHandover).not.toHaveBeenCalled();
  });

  it('stores provider detail but throws only a generic scheduler error', async () => {
    const query = useQueryResults([commandRow('pending'), emptyResult(), emptyResult()]);
    handoverMocks.summarizeHandover.mockRejectedValue(
      new Error('Hermes echoed private resident narrative'),
    );

    await expect(processHandoverCommandActivity(context, input)).rejects.toThrow(
      'Handover command processing failed.',
    );
    expect(query.mock.calls.at(-1)?.[1]).toContain('Hermes echoed private resident narrative');
  });
});

function commandRow(status: 'pending' | 'processing' | 'applied' | 'failed') {
  return {
    rowCount: 1,
    rows: [{ failure_reason: null, payload, status }],
  };
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
