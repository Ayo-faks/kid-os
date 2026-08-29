import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());
const withSystemContextMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withSystemContext: withSystemContextMock,
  withTenantContext: withTenantContextMock,
}));

import {
  findSafeguardingDigestTargets,
  hasSafeguardingDigestAudit,
  loadSafeguardingDigest,
  recordSafeguardingDigestAudit,
} from './safeguarding-digest.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const correlationId = 'corr-safeguarding-digest-test';

const actor = {
  correlationId,
  kind: 'system' as const,
  userId: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('findSafeguardingDigestTargets', () => {
  it('lists tenant/home pairs with a safeguarding channel mapping under system context', async () => {
    mockSystemClient([
      {
        rowCount: 2,
        rows: [
          { home_id: homeId, tenant_id: tenantId },
          {
            home_id: '33333333-3333-4333-8333-333333333333',
            tenant_id: tenantId,
          },
        ],
      },
    ]);

    const result = await findSafeguardingDigestTargets({ correlationId });

    expect(result.targets).toEqual([
      { homeId, tenantId },
      { homeId: '33333333-3333-4333-8333-333333333333', tenantId },
    ]);
    expect(withSystemContextMock).toHaveBeenCalledWith({ correlationId }, expect.any(Function));
  });

  it('returns an empty list when no mappings exist', async () => {
    mockSystemClient([{ rowCount: 0, rows: [] }]);
    const result = await findSafeguardingDigestTargets({ correlationId });
    expect(result.targets).toEqual([]);
  });
});

describe('loadSafeguardingDigest', () => {
  it('counts sensitive drafts and incident states in the window', async () => {
    const query = mockTenantClient([
      { rowCount: 1, rows: [{ count: '3' }] },
      { rowCount: 1, rows: [{ count: '5' }] },
      { rowCount: 1, rows: [{ count: '8' }] },
    ]);

    const digest = await loadSafeguardingDigest({
      actor,
      homeId,
      nowIso: '2026-05-25T08:00:00.000Z',
      sinceIso: '2026-05-18T08:00:00.000Z',
      tenantId,
    });

    expect(digest).toEqual({
      incidentsAwaitingAction: 5,
      incidentsOpened: 8,
      nowIso: '2026-05-25T08:00:00.000Z',
      sensitiveEmailDrafts: 3,
      sinceIso: '2026-05-18T08:00:00.000Z',
    });
    const [, sensitiveParams] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(sensitiveParams).toEqual(['2026-05-18T08:00:00.000Z', '2026-05-25T08:00:00.000Z']);
  });

  it('returns zeros when count rows are missing', async () => {
    mockTenantClient([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ]);
    const digest = await loadSafeguardingDigest({
      actor,
      homeId,
      nowIso: '2026-05-25T08:00:00.000Z',
      sinceIso: '2026-05-18T08:00:00.000Z',
      tenantId,
    });
    expect(digest.sensitiveEmailDrafts).toBe(0);
    expect(digest.incidentsAwaitingAction).toBe(0);
    expect(digest.incidentsOpened).toBe(0);
  });
});

describe('hasSafeguardingDigestAudit', () => {
  it.each([
    ['finds a prior delivery', [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], true],
    ['reports an unseen delivery', [], false],
  ])('%s', async (_title, rows, expected) => {
    const query = mockTenantClient([{ rowCount: rows.length, rows }]);

    await expect(
      hasSafeguardingDigestAudit({
        actor,
        homeId,
        nowIso: '2026-05-25T08:00:00.000Z',
        tenantId,
      }),
    ).resolves.toBe(expected);
    expect(query.mock.calls[0]?.[1]).toEqual([
      tenantId,
      homeId,
      `${tenantId}:${homeId}:2026-05-25T08:00:00.000Z`,
    ]);
  });
});

describe('recordSafeguardingDigestAudit', () => {
  it('inserts an audit event and returns the new id', async () => {
    const query = mockTenantClient([
      { rowCount: 1, rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] },
    ]);
    const result = await recordSafeguardingDigestAudit({
      actor,
      digest: {
        incidentsAwaitingAction: 1,
        incidentsOpened: 2,
        nowIso: '2026-05-25T08:00:00.000Z',
        sensitiveEmailDrafts: 3,
        sinceIso: '2026-05-18T08:00:00.000Z',
      },
      homeId,
      tenantId,
    });
    expect(result).toEqual({
      auditEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      recorded: true,
    });
    const [, params] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(params[0]).toBe(tenantId);
    expect(params[1]).toBe(homeId);
    expect(params[2]).toBe(correlationId);
    expect(JSON.parse(params[3] as string)).toEqual({
      dispatch_key: `${tenantId}:${homeId}:2026-05-25T08:00:00.000Z`,
      incidents_awaiting_action: 1,
      incidents_opened: 2,
      now: '2026-05-25T08:00:00.000Z',
      sensitive_email_drafts: 3,
      since: '2026-05-18T08:00:00.000Z',
    });
  });

  it('returns recorded=false when the insert returns no rows', async () => {
    mockTenantClient([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ]);
    const result = await recordSafeguardingDigestAudit({
      actor,
      digest: {
        incidentsAwaitingAction: 0,
        incidentsOpened: 0,
        nowIso: '2026-05-25T08:00:00.000Z',
        sensitiveEmailDrafts: 0,
        sinceIso: '2026-05-18T08:00:00.000Z',
      },
      homeId,
      tenantId,
    });
    expect(result).toEqual({ auditEventId: null, recorded: false });
  });

  it('returns the existing keyed audit event when a retry loses the insert acknowledgement', async () => {
    const query = mockTenantClient([
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] },
    ]);

    await expect(
      recordSafeguardingDigestAudit({
        actor,
        digest: {
          incidentsAwaitingAction: 1,
          incidentsOpened: 2,
          nowIso: '2026-05-25T08:00:00.000Z',
          sensitiveEmailDrafts: 3,
          sinceIso: '2026-05-18T08:00:00.000Z',
        },
        homeId,
        tenantId,
      }),
    ).resolves.toEqual({
      auditEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      recorded: true,
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('ON CONFLICT DO NOTHING');
    expect(query.mock.calls[1]?.[1]).toEqual([
      tenantId,
      homeId,
      `${tenantId}:${homeId}:2026-05-25T08:00:00.000Z`,
    ]);
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
