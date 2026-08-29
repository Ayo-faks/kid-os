import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());
const withSystemContextMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withSystemContext: withSystemContextMock,
  withTenantContext: withTenantContextMock,
}));

import {
  findUpcomingShifts,
  loadShiftReminderContext,
  markShiftReminderSent,
} from './shift-reminders.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const shiftId = '33333333-3333-4333-8333-333333333333';
const correlationId = 'corr-sr-test';

const actor = {
  correlationId,
  kind: 'system' as const,
  userId: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('findUpcomingShifts', () => {
  it('queries shifts in the [now+min, now+max) window under system context', async () => {
    const startsAt = new Date('2026-05-18T10:30:00.000Z');
    const query = mockSystemClient([
      {
        rowCount: 1,
        rows: [
          {
            home_id: homeId,
            id: shiftId,
            min_headcount: 3,
            required_role: 'support_worker',
            starts_at: startsAt,
            tenant_id: tenantId,
          },
        ],
      },
    ]);

    const result = await findUpcomingShifts({
      correlationId,
      maxLookaheadMinutes: 35,
      minLookaheadMinutes: 25,
      nowIso: '2026-05-18T10:00:00.000Z',
    });

    expect(result.shifts).toEqual([
      {
        homeId,
        minHeadcount: 3,
        requiredRole: 'support_worker',
        shiftId,
        startsAtIso: startsAt.toISOString(),
        tenantId,
      },
    ]);
    expect(withSystemContextMock).toHaveBeenCalledWith({ correlationId }, expect.any(Function));
    const [, params] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(params).toEqual(['2026-05-18T10:25:00.000Z', '2026-05-18T10:35:00.000Z']);
  });

  it('returns an empty list when no rows match', async () => {
    mockSystemClient([{ rowCount: 0, rows: [] }]);
    const result = await findUpcomingShifts({
      correlationId,
      maxLookaheadMinutes: 35,
      minLookaheadMinutes: 25,
      nowIso: '2026-05-18T10:00:00.000Z',
    });
    expect(result.shifts).toEqual([]);
  });
});

describe('loadShiftReminderContext', () => {
  it('returns null when the shift does not exist in the tenant scope', async () => {
    mockTenantClient([{ rowCount: 0, rows: [] }]);
    const ctx = await loadShiftReminderContext({
      actor,
      homeId,
      shiftId,
      tenantId,
    });
    expect(ctx).toBeNull();
  });

  it('reports already-reminded when reminder_sent_at is set', async () => {
    const startsAt = new Date('2026-05-18T10:30:00.000Z');
    mockTenantClient([
      {
        rowCount: 1,
        rows: [
          {
            assigned_headcount: '2',
            id: shiftId,
            min_headcount: 3,
            reminder_sent_at: new Date('2026-05-18T09:55:00.000Z'),
            required_role: 'support_worker',
            starts_at: startsAt,
          },
        ],
      },
    ]);

    const ctx = await loadShiftReminderContext({
      actor,
      homeId,
      shiftId,
      tenantId,
    });

    expect(ctx).toEqual({
      alreadyReminded: true,
      assignedHeadcount: 2,
      minHeadcount: 3,
      requiredRole: 'support_worker',
      shiftId,
      startsAtIso: startsAt.toISOString(),
    });
  });
});

describe('markShiftReminderSent', () => {
  it('returns recorded=true on the first call', async () => {
    mockTenantClient([{ rowCount: 1, rows: [] }]);
    const result = await markShiftReminderSent({
      actor,
      homeId,
      shiftId,
      tenantId,
    });
    expect(result.recorded).toBe(true);
  });

  it('returns recorded=false when reminder_sent_at is already populated', async () => {
    mockTenantClient([{ rowCount: 0, rows: [] }]);
    const result = await markShiftReminderSent({
      actor,
      homeId,
      shiftId,
      tenantId,
    });
    expect(result.recorded).toBe(false);
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

function mockSystemClient(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>();
  for (const result of results) {
    query.mockResolvedValueOnce(result);
  }
  withSystemContextMock.mockImplementation(
    (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) =>
      callback({ query } as unknown as PoolClient),
  );
  return query;
}
