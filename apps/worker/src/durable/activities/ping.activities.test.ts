import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const helloHermesMock = vi.hoisted(() => vi.fn());
const withSystemContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/hermes.js', () => ({ helloHermes: helloHermesMock }));
vi.mock('../../db/pg.js', () => ({ withSystemContext: withSystemContextMock }));

import { processPingCommandActivity } from './ping.activities.js';

const context = new ActivityContext('ping-test', 1);
const input = {
  commandId: '66666666-6666-4666-8666-666666666666',
  correlationId: 'corr-ping',
  pingId: '44444444-4444-4444-8444-444444444444',
};

describe('Durable Ping command activity', () => {
  afterEach(() => vi.clearAllMocks());

  it('loads the custom message from Postgres and returns operational status only', async () => {
    const query = useQueryResults([
      commandRow('pending', { message: 'private custom ping' }),
      emptyResult(),
      emptyResult(),
      emptyResult(),
    ]);
    helloHermesMock.mockResolvedValue({
      body: 'private Hermes body',
      hermesUrl: 'http://hermes:8080',
      message: 'private custom ping',
      status: 200,
    });

    const result = await processPingCommandActivity(context, input);

    expect(helloHermesMock).toHaveBeenCalledWith({ message: 'private custom ping' });
    expect(result).toEqual({ httpStatus: 200, pingId: input.pingId, status: 'healthy' });
    expect(JSON.stringify(result)).not.toMatch(/private|message|body|hermesUrl/);
    expect(String(query.mock.calls[2]?.[1])).toContain('healthy');
  });

  it('rehydrates an applied operational result without calling Hermes again', async () => {
    useQueryResults([
      commandRow(
        'applied',
        { message: 'private custom ping' },
        { httpStatus: 204, pingId: input.pingId, status: 'healthy' },
      ),
    ]);

    await expect(processPingCommandActivity(context, input)).resolves.toEqual({
      httpStatus: 204,
      pingId: input.pingId,
      status: 'healthy',
    });
    expect(helloHermesMock).not.toHaveBeenCalled();
  });

  it('masks detailed Hermes errors', async () => {
    useQueryResults([commandRow('pending', { message: 'private custom ping' }), emptyResult()]);
    helloHermesMock.mockRejectedValue(new Error('private Hermes response body'));

    await expect(processPingCommandActivity(context, input)).rejects.toThrow(
      'Ping command processing failed.',
    );
  });
});

function commandRow(
  status: 'pending' | 'processing' | 'applied' | 'failed',
  payload: unknown,
  result: unknown = null,
) {
  return { rowCount: 1, rows: [{ payload, result, status }] };
}

function emptyResult() {
  return { rowCount: 1, rows: [] };
}

function useQueryResults(
  results: Array<{ readonly rowCount: number; readonly rows: readonly unknown[] }>,
) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  withSystemContextMock.mockImplementation(
    (_context: unknown, callback: (client: { query: typeof query }) => Promise<unknown>) =>
      callback({ query }),
  );
  return query;
}
