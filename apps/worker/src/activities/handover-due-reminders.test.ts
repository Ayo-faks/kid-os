import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());
const withSystemContextMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withSystemContext: withSystemContextMock,
  withTenantContext: withTenantContextMock,
}));

import {
  findOverdueHandoverShifts,
  loadHandoverDueReminderContext,
  markHandoverDueReminderSent,
} from './handover-due-reminders.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const shiftId = '33333333-3333-4333-8333-333333333333';
const correlationId = 'corr-hdr-test';

const actor = {
  correlationId,
  kind: 'system' as const,
  userId: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('findOverdueHandoverShifts', () => {
  it('queries shifts in the [now-max, now-min) window under system context', async () => {
    const endsAt = new Date('2026-05-18T09:30:00.000Z');
    const query = mockSystemClient([
      {
        rowCount: 1,
        rows: [
          {
            ends_at: endsAt,
            home_id: homeId,
            id: shiftId,
            required_role: 'support_worker',
            tenant_id: tenantId,
          },
        ],
      },
    ]);

    const result = await findOverdueHandoverShifts({
      correlationId,
      maxOverdueMinutes: 240,
      minOverdueMinutes: 15,
      nowIso: '2026-05-18T10:00:00.000Z',
    });

    expect(result.shifts).toEqual([
      {
        endsAtIso: endsAt.toISOString(),
        homeId,
        requiredRole: 'support_worker',
        shiftId,
        tenantId,
      },
    ]);
    expect(withSystemContextMock).toHaveBeenCalledWith({ correlationId }, expect.any(Function));
    const [, params] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(params).toEqual(['2026-05-18T06:00:00.000Z', '2026-05-18T09:45:00.000Z']);
  });

  it('returns an empty list when no rows match', async () => {
    mockSystemClient([{ rowCount: 0, rows: [] }]);
    const result = await findOverdueHandoverShifts({
      correlationId,
      maxOverdueMinutes: 240,
      minOverdueMinutes: 15,
      nowIso: '2026-05-18T10:00:00.000Z',
    });
    expect(result.shifts).toEqual([]);
  });
});

describe('loadHandoverDueReminderContext', () => {
  it('returns null when the shift is not visible in the tenant scope', async () => {
    mockTenantClient([{ rowCount: 0, rows: [] }]);
    const ctx = await loadHandoverDueReminderContext({
      actor,
      homeId,
      shiftId,
      tenantId,
    });
    expect(ctx).toBeNull();
  });

  it('flags handoverRecorded when a handover_records row exists', async () => {
    const endsAt = new Date('2026-05-18T09:30:00.000Z');
    mockTenantClient([
      {
        rowCount: 1,
        rows: [
          {
            ends_at: endsAt,
            handover_count: '1',
            handover_due_reminder_sent_at: null,
            id: shiftId,
            required_role: 'support_worker',
          },
        ],
      },
    ]);

    const ctx = await loadHandoverDueReminderContext({
      actor,
      homeId,
      shiftId,
      tenantId,
    });

    expect(ctx).toEqual({
      alreadyReminded: false,
      endsAtIso: endsAt.toISOString(),
      handoverRecorded: true,
      requiredRole: 'support_worker',
      shiftId,
    });
  });

  it('reports already-reminded when handover_due_reminder_sent_at is set', async () => {
    const endsAt = new Date('2026-05-18T09:30:00.000Z');
    mockTenantClient([
      {
        rowCount: 1,
        rows: [
          {
            ends_at: endsAt,
            handover_count: '0',
            handover_due_reminder_sent_at: new Date('2026-05-18T09:55:00.000Z'),
            id: shiftId,
            required_role: 'support_worker',
          },
        ],
      },
    ]);

    const ctx = await loadHandoverDueReminderContext({
      actor,
      homeId,
      shiftId,
      tenantId,
    });

    expect(ctx).toMatchObject({
      alreadyReminded: true,
      handoverRecorded: false,
    });
  });
});

describe('markHandoverDueReminderSent', () => {
  it('returns recorded=true on the first call', async () => {
    mockTenantClient([{ rowCount: 1, rows: [] }]);
    const result = await markHandoverDueReminderSent({
      actor,
      homeId,
      shiftId,
      tenantId,
    });
    expect(result.recorded).toBe(true);
  });

  it('returns recorded=false when the column is already populated', async () => {
    mockTenantClient([{ rowCount: 0, rows: [] }]);
    const result = await markHandoverDueReminderSent({
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
