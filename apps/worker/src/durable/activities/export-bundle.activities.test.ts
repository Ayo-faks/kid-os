import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exportMocks = vi.hoisted(() => ({
  composeExportBundle: vi.fn(),
  markExportBundleBuilding: vi.fn(),
  markExportBundleFailed: vi.fn(),
  markExportBundleReady: vi.fn(),
}));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/export-bundles.js', () => exportMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import { processSeriousIncidentExportActivity } from './export-bundle.activities.js';

const context = new ActivityContext('export-bundle-test', 1);
const input = {
  actor: {
    correlationId: 'corr-export',
    kind: 'user' as const,
    userId: '55555555-5555-4555-8555-555555555555',
  },
  bundleId: '44444444-4444-4444-8444-444444444444',
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('Durable Serious Incident Export composite activity', () => {
  beforeEach(() => {
    exportMocks.markExportBundleBuilding.mockResolvedValue({ transitioned: true });
    exportMocks.markExportBundleReady.mockResolvedValue({ transitioned: true });
    exportMocks.markExportBundleFailed.mockResolvedValue({ transitioned: true });
    exportMocks.composeExportBundle.mockResolvedValue({
      manifestSha256: 'a'.repeat(64),
      objectKey: 'tenants/t/incidents/i/bundles/b.zip',
      retainUntilIso: '2033-07-18T00:00:00.000Z',
      signature: 'b'.repeat(64),
      signatureAlgorithm: 'HMAC-SHA256',
      sizeBytes: 2048,
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('persists bundle metadata but returns only an operational terminal result', async () => {
    useStatuses(['pending', 'building', 'ready']);

    const result = await processSeriousIncidentExportActivity(context, input);

    expect(exportMocks.markExportBundleReady).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestSha256: 'a'.repeat(64),
        objectKey: 'tenants/t/incidents/i/bundles/b.zip',
        signature: 'b'.repeat(64),
      }),
    );
    expect(result).toEqual({ bundleId: input.bundleId, status: 'ready' });
    expect(JSON.stringify(result)).not.toContain('objectKey');
    expect(JSON.stringify(result)).not.toContain('signature');
  });

  it('reconciles a lost acknowledgement after ready without composing twice', async () => {
    useStatuses(['ready']);

    await expect(processSeriousIncidentExportActivity(context, input)).resolves.toEqual({
      bundleId: input.bundleId,
      status: 'ready',
    });
    expect(exportMocks.composeExportBundle).not.toHaveBeenCalled();
    expect(exportMocks.markExportBundleBuilding).not.toHaveBeenCalled();
  });

  it('stores detailed composition failure but returns only a closed code', async () => {
    useStatuses(['pending', 'building', 'failed']);
    exportMocks.composeExportBundle.mockRejectedValue(
      new Error('Bundle source included resident narrative'),
    );

    const result = await processSeriousIncidentExportActivity(context, input);

    expect(exportMocks.markExportBundleFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Bundle source included resident narrative' }),
    );
    expect(result).toEqual({
      bundleId: input.bundleId,
      outcomeCode: 'bundle-build-failed',
      status: 'failed',
    });
    expect(JSON.stringify(result)).not.toContain('resident narrative');
  });
});

function useStatuses(statuses: readonly string[]): void {
  const remaining = [...statuses];
  const query = vi.fn((sql: string) => {
    if (sql.includes('SELECT status::text AS status')) {
      const status = remaining.shift();
      return Promise.resolve({ rows: status === undefined ? [] : [{ status }] });
    }
    return Promise.resolve({ rowCount: 1, rows: [] });
  });
  withTenantContextMock.mockImplementation(
    (_context: unknown, callback: (client: { query: typeof query }) => Promise<unknown>) =>
      callback({ query }),
  );
}
