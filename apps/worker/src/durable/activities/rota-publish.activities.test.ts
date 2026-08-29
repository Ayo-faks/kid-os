import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rotaMocks = vi.hoisted(() => ({ publishRota: vi.fn() }));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/rota.js', () => rotaMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import { processRotaPublishCommandActivity } from './rota-publish.activities.js';

const context = new ActivityContext('rota-publish-test', 1);
const input = {
  actor: {
    correlationId: 'corr-rota-publish',
    kind: 'user' as const,
    userId: '55555555-5555-4555-8555-555555555555',
  },
  commandId: '66666666-6666-4666-8666-666666666666',
  homeId: '22222222-2222-4222-8222-222222222222',
  publicationId: '44444444-4444-4444-8444-444444444444',
  publishedByUserId: '55555555-5555-4555-8555-555555555555',
  shiftIds: ['33333333-3333-4333-8333-333333333333'],
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const payload = {
  actor: input.actor,
  correlationId: input.actor.correlationId,
  homeId: input.homeId,
  note: 'Private manager publication note.',
  periodEnd: '2026-07-25T00:00:00.000Z',
  periodStart: '2026-07-18T00:00:00.000Z',
  publicationId: input.publicationId,
  publishedByUserId: input.publishedByUserId,
  shiftIds: input.shiftIds,
  tenantId: input.tenantId,
};

describe('Durable Rota Publish command activity', () => {
  beforeEach(() => {
    rotaMocks.publishRota.mockResolvedValue({
      publicationId: input.publicationId,
      publishedAssignmentIds: ['77777777-7777-4777-8777-777777777777'],
      status: 'published',
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('resolves the note from Postgres and returns assignment IDs only', async () => {
    useQueryResults([commandRow('pending'), emptyResult(), emptyResult(), emptyResult()]);

    const result = await processRotaPublishCommandActivity(context, input);

    expect(rotaMocks.publishRota).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'Private manager publication note.' }),
    );
    expect(result).toEqual({
      publicationId: input.publicationId,
      publishedAssignmentIds: ['77777777-7777-4777-8777-777777777777'],
      status: 'published',
    });
    expect(JSON.stringify(result)).not.toContain('Private manager publication note.');
  });

  it('rehydrates an applied publication without publishing twice', async () => {
    useQueryResults([
      commandRow('applied'),
      {
        rowCount: 1,
        rows: [
          {
            assignment_ids: ['77777777-7777-4777-8777-777777777777'],
            id: input.publicationId,
            status: 'published',
          },
        ],
      },
    ]);

    await expect(processRotaPublishCommandActivity(context, input)).resolves.toMatchObject({
      status: 'published',
    });
    expect(rotaMocks.publishRota).not.toHaveBeenCalled();
  });

  it('returns a closed failure code for a persisted failed publication', async () => {
    useQueryResults([commandRow('pending'), emptyResult(), emptyResult(), emptyResult()]);
    rotaMocks.publishRota.mockResolvedValue({
      publicationId: input.publicationId,
      publishedAssignmentIds: [],
      status: 'failed',
    });

    await expect(processRotaPublishCommandActivity(context, input)).resolves.toEqual({
      outcomeCode: 'processing-failed',
      publicationId: input.publicationId,
      publishedAssignmentIds: [],
      status: 'failed',
    });
  });

  it('stores detailed failure but throws only a generic scheduler error', async () => {
    const query = useQueryResults([commandRow('pending'), emptyResult(), emptyResult()]);
    rotaMocks.publishRota.mockRejectedValue(new Error('Private rota note caused DB failure'));

    await expect(processRotaPublishCommandActivity(context, input)).rejects.toThrow(
      'Rota publish command processing failed.',
    );
    expect(query.mock.calls.at(-1)?.[1]).toContain('Private rota note caused DB failure');
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
