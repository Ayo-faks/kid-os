import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withSystemContextMock = vi.hoisted(() => vi.fn());
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withSystemContext: withSystemContextMock,
  withTenantContext: withTenantContextMock,
}));

import {
  __setRetentionObjectStoreForTests,
  applyRetentionPolicy,
  listActiveRetentionPolicies,
} from './retention.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const policyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const homeAId = '22222222-2222-4222-8222-222222222222';
const homeBId = '33333333-3333-4333-8333-333333333333';
const correlationId = 'corr-retention';

const actor = {
  correlationId,
  kind: 'system' as const,
  userId: null,
};

afterEach(() => {
  vi.clearAllMocks();
  __setRetentionObjectStoreForTests(undefined);
  delete process.env.MINIO_ATTACHMENTS_BUCKET;
});

function nextClient(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn();
  for (const r of results) {
    query.mockResolvedValueOnce(r);
  }
  return { client: { query } as unknown as PoolClient, query };
}

describe('listActiveRetentionPolicies', () => {
  it('returns snapshots from system-context query, ordered by tenant/record_type', async () => {
    const { client, query } = nextClient([
      {
        rowCount: 2,
        rows: [
          {
            action: 'soft_delete',
            enabled: true,
            id: policyId,
            record_type: 'incident',
            retention_days: 30,
            tenant_id: tenantId,
          },
          {
            action: 'object_delete',
            enabled: true,
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            record_type: 'attachment',
            retention_days: 7,
            tenant_id: tenantId,
          },
        ],
      },
    ]);
    withSystemContextMock.mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) =>
      cb(client),
    );

    const result = await listActiveRetentionPolicies({ correlationId });

    expect(result.policies).toHaveLength(2);
    expect(result.policies[0]).toEqual({
      action: 'soft_delete',
      enabled: true,
      id: policyId,
      recordType: 'incident',
      retentionDays: 30,
      tenantId,
    });
    expect(query).toHaveBeenCalledOnce();
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM core\.retention_policies/);
    expect(sql).toMatch(/enabled = true/);
  });
});

describe('applyRetentionPolicy (incident → soft_delete)', () => {
  it('enumerates homes, scans + updates per home, then records one run', async () => {
    // System context: list homes
    const homesClient = nextClient([
      {
        rowCount: 2,
        rows: [{ id: homeAId }, { id: homeBId }],
      },
    ]);
    withSystemContextMock.mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) =>
      cb(homesClient.client),
    );

    // Per-home tenant context: scan + update
    const homeA = nextClient([
      { rowCount: 1, rows: [{ count: '5' }] },
      { rowCount: 5, rows: [] },
    ]);
    const homeB = nextClient([
      { rowCount: 1, rows: [{ count: '2' }] },
      { rowCount: 2, rows: [] },
    ]);
    const runInsert = nextClient([{ rowCount: 1, rows: [{ id: 'run-1' }] }]);
    withTenantContextMock
      .mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) => cb(homeA.client))
      .mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) => cb(homeB.client))
      .mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) => cb(runInsert.client));

    const result = await applyRetentionPolicy({
      actor,
      nowIso: '2026-05-18T00:00:00.000Z',
      policy: {
        action: 'soft_delete',
        enabled: true,
        id: policyId,
        recordType: 'incident',
        retentionDays: 30,
        tenantId,
      },
      workflowId: 'retention-sweep-2026-05-18T00:00:00.000Z',
    });

    expect(result).toEqual({
      affectedCount: 7,
      runId: 'run-1',
      scannedCount: 7,
    });

    // home A scan SQL targets core.incidents and filters soft_deleted_at IS NULL
    const [scanSql] = homeA.query.mock.calls[0] as [string];
    expect(scanSql).toMatch(/FROM core\.incidents/);
    expect(scanSql).toMatch(/soft_deleted_at IS NULL/);
    // home A update SQL touches updated_at (non-attachment)
    const [updSql] = homeA.query.mock.calls[1] as [string];
    expect(updSql).toMatch(/UPDATE core\.incidents/);
    expect(updSql).toMatch(/updated_at = NOW\(\)/);
    expect(updSql).toMatch(/retention_policy_id = \$3::uuid/);

    // run insert sql writes to core.retention_runs
    const [runSql] = runInsert.query.mock.calls[0] as [string, unknown[]];
    expect(runSql).toMatch(/INSERT INTO core\.retention_runs/);
  });

  it('returns the original keyed run counts when a retry finds no remaining rows', async () => {
    const homesClient = nextClient([{ rowCount: 0, rows: [] }]);
    const runInsert = nextClient([
      {
        rowCount: 1,
        rows: [{ affected_count: 7, id: 'run-original', scanned_count: 9 }],
      },
    ]);
    withSystemContextMock.mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) =>
      cb(homesClient.client),
    );
    withTenantContextMock.mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) =>
      cb(runInsert.client),
    );

    await expect(
      applyRetentionPolicy({
        actor,
        nowIso: '2026-05-18T00:00:00.000Z',
        policy: {
          action: 'soft_delete',
          enabled: true,
          id: policyId,
          recordType: 'incident',
          retentionDays: 30,
          tenantId,
        },
        workflowId: 'retention-sweep-retry',
      }),
    ).resolves.toEqual({
      affectedCount: 7,
      runId: 'run-original',
      scannedCount: 9,
    });
    expect(String(runInsert.query.mock.calls[0]?.[0])).toContain('ON CONFLICT (execution_key)');
  });
});

describe('applyRetentionPolicy (attachment → object_delete)', () => {
  it('deletes and verifies the object before marking the attachment', async () => {
    process.env.MINIO_ATTACHMENTS_BUCKET = 'test-attachments';
    const removeObject = vi.fn(() => Promise.resolve());
    const objectExists = vi.fn(() => Promise.resolve(false));
    __setRetentionObjectStoreForTests({ objectExists, removeObject });
    const homesClient = nextClient([{ rowCount: 1, rows: [{ id: homeAId }] }]);
    withSystemContextMock.mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) =>
      cb(homesClient.client),
    );
    const attachmentScan = nextClient([
      {
        rowCount: 1,
        rows: [{ id: 'attachment-1', object_key: 'tenant/home/file.pdf' }],
      },
    ]);
    const attachmentMark = nextClient([{ rowCount: 1, rows: [] }]);
    const runInsert = nextClient([{ rowCount: 1, rows: [{ id: 'run-2' }] }]);
    withTenantContextMock
      .mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) =>
        cb(attachmentScan.client),
      )
      .mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) =>
        cb(attachmentMark.client),
      )
      .mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) => cb(runInsert.client));

    const result = await applyRetentionPolicy({
      actor,
      nowIso: '2026-05-18T00:00:00.000Z',
      policy: {
        action: 'object_delete',
        enabled: true,
        id: policyId,
        recordType: 'attachment',
        retentionDays: 7,
        tenantId,
      },
      workflowId: 'retention-sweep-2026-05-18T00:00:00.000Z',
    });

    expect(result.affectedCount).toBe(1);
    expect(result.scannedCount).toBe(1);
    expect(removeObject).toHaveBeenCalledWith('test-attachments', 'tenant/home/file.pdf');
    expect(objectExists).toHaveBeenCalledWith('test-attachments', 'tenant/home/file.pdf');

    const [scanSql] = attachmentScan.query.mock.calls[0] as [string];
    expect(scanSql).toMatch(/FROM core\.attachments/);
    expect(scanSql).toMatch(/object_deleted_at IS NULL/);

    const [updSql] = attachmentMark.query.mock.calls[0] as [string];
    expect(updSql).toMatch(/UPDATE core\.attachments/);
    expect(updSql).toMatch(/object_deleted_at = \$1::timestamptz/);
    expect(updSql).not.toMatch(/updated_at = NOW\(\)/);
  });

  it('does not write a success marker when object absence cannot be verified', async () => {
    __setRetentionObjectStoreForTests({
      objectExists: vi.fn(() => Promise.resolve(true)),
      removeObject: vi.fn(() => Promise.resolve()),
    });
    const homesClient = nextClient([{ rowCount: 1, rows: [{ id: homeAId }] }]);
    const attachmentScan = nextClient([
      {
        rowCount: 1,
        rows: [{ id: 'attachment-1', object_key: 'tenant/home/file.pdf' }],
      },
    ]);
    withSystemContextMock.mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) =>
      cb(homesClient.client),
    );
    withTenantContextMock.mockImplementationOnce((_: unknown, cb: (c: PoolClient) => unknown) =>
      cb(attachmentScan.client),
    );

    await expect(
      applyRetentionPolicy({
        actor,
        nowIso: '2026-05-18T00:00:00.000Z',
        policy: {
          action: 'object_delete',
          enabled: true,
          id: policyId,
          recordType: 'attachment',
          retentionDays: 7,
          tenantId,
        },
        workflowId: 'retention-sweep-2026-05-18T00:00:00.000Z',
      }),
    ).rejects.toThrow(/still exists after deletion/i);
    expect(withTenantContextMock).toHaveBeenCalledTimes(1);
  });
});
