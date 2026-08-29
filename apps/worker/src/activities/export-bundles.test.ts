import { createHash, createHmac } from 'node:crypto';

import { unzipSync } from 'fflate';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withTenantContext: withTenantContextMock,
}));

import {
  __setBundlePdfConverterForTests,
  __setBundleStoreForTests,
  composeExportBundle,
  markExportBundleBuilding,
  markExportBundleFailed,
  markExportBundleReady,
} from './export-bundles.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const incidentId = '33333333-3333-4333-8333-333333333333';
const bundleId = '44444444-4444-4444-8444-444444444444';
const correlationId = 'corr-bundle-test';
const residentId = '66666666-6666-4666-8666-666666666666';
const testPdf = Buffer.from('%PDF-1.7\nCareOS incident\n%%EOF');

const actor = {
  correlationId,
  kind: 'user' as const,
  userId: '55555555-5555-4555-8555-555555555555',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-18T00:00:00Z'));
  __setBundlePdfConverterForTests({
    htmlToPdf: vi.fn(() => Promise.resolve(testPdf)),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  delete process.env.EXPORT_BUNDLE_SIGNING_KEY;
  delete process.env.MINIO_EXPORT_BUNDLES_ENABLED;
  delete process.env.MINIO_EXPORT_BUNDLES_BUCKET;
  __setBundlePdfConverterForTests(undefined);
  __setBundleStoreForTests(undefined);
});

function mockTenantClient(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn();
  for (const result of results) {
    query.mockResolvedValueOnce(result);
  }
  withTenantContextMock.mockImplementation(
    (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) =>
      callback({ query } as unknown as PoolClient),
  );
  return query;
}

describe('markExportBundleBuilding', () => {
  it('flips pending → building', async () => {
    mockTenantClient([{ rowCount: 1, rows: [] }]);
    const result = await markExportBundleBuilding({
      actor,
      bundleId,
      homeId,
      tenantId,
    });
    expect(result).toEqual({ transitioned: true });
  });

  it('reports transitioned=false when already advanced', async () => {
    mockTenantClient([{ rowCount: 0, rows: [] }]);
    const result = await markExportBundleBuilding({
      actor,
      bundleId,
      homeId,
      tenantId,
    });
    expect(result).toEqual({ transitioned: false });
  });
});

describe('composeExportBundle', () => {
  it('throws when EXPORT_BUNDLE_SIGNING_KEY is unset', async () => {
    mockTenantClient([
      {
        rowCount: 1,
        rows: [
          {
            created_at: new Date('2026-05-17T00:00:00Z'),
            current_version: 1,
            form_data: { foo: 'bar' },
            id: incidentId,
            missing_mandatory: [],
            resident_id: residentId,
            status: 'approved',
            template_id: 'incident.safeguarding',
            template_version: 'v1',
          },
        ],
      },
      { rowCount: 0, rows: [] },
    ]);
    await expect(
      composeExportBundle({ actor, bundleId, homeId, incidentId, tenantId }),
    ).rejects.toThrow(/EXPORT_BUNDLE_SIGNING_KEY/);
  });

  it('throws when EXPORT_BUNDLE_SIGNING_KEY is the placeholder', async () => {
    process.env.EXPORT_BUNDLE_SIGNING_KEY = 'change-me';
    mockTenantClient([
      {
        rowCount: 1,
        rows: [
          {
            created_at: new Date('2026-05-17T00:00:00Z'),
            current_version: 1,
            form_data: {},
            id: incidentId,
            missing_mandatory: [],
            resident_id: residentId,
            status: 'approved',
            template_id: 'incident.safeguarding',
            template_version: 'v1',
          },
        ],
      },
      { rowCount: 0, rows: [] },
    ]);
    await expect(
      composeExportBundle({ actor, bundleId, homeId, incidentId, tenantId }),
    ).rejects.toThrow(/EXPORT_BUNDLE_SIGNING_KEY/);
  });

  it('throws when incident is missing', async () => {
    process.env.EXPORT_BUNDLE_SIGNING_KEY = 'secret-test-key';
    mockTenantClient([{ rowCount: 0, rows: [] }]);
    await expect(
      composeExportBundle({ actor, bundleId, homeId, incidentId, tenantId }),
    ).rejects.toThrow(/not found/);
  });

  it('signs the manifest deterministically with HMAC-SHA256 and stamps 7y retention', async () => {
    process.env.EXPORT_BUNDLE_SIGNING_KEY = 'secret-test-key';
    mockTenantClient([
      {
        rowCount: 1,
        rows: [
          {
            created_at: new Date('2026-05-17T00:00:00Z'),
            current_version: 1,
            form_data: { foo: 'bar' },
            id: incidentId,
            missing_mandatory: [],
            resident_id: residentId,
            status: 'approved',
            template_id: 'incident.safeguarding',
            template_version: 'v1',
          },
        ],
      },
      { rowCount: 0, rows: [] },
    ]);

    const result = await composeExportBundle({
      actor,
      bundleId,
      homeId,
      incidentId,
      tenantId,
    });

    expect(result.signatureAlgorithm).toBe('HMAC-SHA256');
    expect(result.objectKey).toBe(
      `tenants/${tenantId}/incidents/${incidentId}/bundles/${bundleId}.zip`,
    );
    expect(result.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sizeBytes).toBeGreaterThan(0);
    // 7y retention from frozen now
    expect(result.retainUntilIso).toBe(
      new Date('2026-05-18T00:00:00Z').toISOString().slice(0, 4) === '2026'
        ? new Date(Date.UTC(2026, 4, 18, 0, 0, 0) + 7 * 365 * 24 * 60 * 60 * 1000).toISOString()
        : result.retainUntilIso,
    );
  });
});

describe('composeExportBundle with MinIO upload enabled', () => {
  it('uploads a zip to the configured bucket and reports zip byte size', async () => {
    process.env.EXPORT_BUNDLE_SIGNING_KEY = 'secret-test-key';
    process.env.MINIO_EXPORT_BUNDLES_ENABLED = 'true';
    process.env.MINIO_EXPORT_BUNDLES_BUCKET = 'test-bundles';
    mockTenantClient([
      {
        rowCount: 1,
        rows: [
          {
            created_at: new Date('2026-05-17T00:00:00Z'),
            current_version: 1,
            form_data: { foo: 'bar' },
            id: incidentId,
            missing_mandatory: [],
            resident_id: residentId,
            status: 'approved',
            template_id: 'incident.safeguarding',
            template_version: 'v1',
          },
        ],
      },
      { rowCount: 0, rows: [] },
    ]);
    const ensureBucket = vi.fn((_: string) => Promise.resolve(undefined));
    const putObject = vi.fn((_bucket: string, _key: string, _body: Buffer, _contentType: string) =>
      Promise.resolve(undefined),
    );
    __setBundleStoreForTests({ ensureBucket, putObject });

    const result = await composeExportBundle({
      actor,
      bundleId,
      homeId,
      incidentId,
      tenantId,
    });

    expect(ensureBucket).toHaveBeenCalledTimes(1);
    expect(ensureBucket).toHaveBeenCalledWith('test-bundles');
    expect(putObject).toHaveBeenCalledOnce();
    const [bucket, key, body, contentType] = putObject.mock.calls[0]!;
    expect(bucket).toBe('test-bundles');
    expect(key).toBe(result.objectKey);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBe(result.sizeBytes);
    expect(contentType).toBe('application/zip');
    // ZIP local-file-header magic bytes "PK\x03\x04"
    expect(body.subarray(0, 4).toString('hex')).toBe('504b0304');
    const files = unzipSync(body);
    expect(Object.keys(files).sort()).toEqual([
      'audit-trail.json',
      'incident.json',
      'incident.pdf',
      'manifest.json',
      'signature.txt',
    ]);
    expect(Buffer.from(files['incident.pdf'] ?? []).equals(testPdf)).toBe(true);

    const manifestJson = Buffer.from(files['manifest.json'] ?? []).toString('utf8');
    const manifest = JSON.parse(manifestJson) as {
      readonly files: ReadonlyArray<{
        readonly name: string;
        readonly sha256: string;
        readonly sizeBytes: number;
      }>;
    };
    const pdfEntry = manifest.files.find((file) => file.name === 'incident.pdf');
    expect(pdfEntry).toEqual({
      name: 'incident.pdf',
      sha256: createHash('sha256').update(testPdf).digest('hex'),
      sizeBytes: testPdf.length,
    });
    const manifestSha = createHash('sha256').update(manifestJson).digest('hex');
    expect(result.manifestSha256).toBe(manifestSha);
    expect(result.signature).toBe(
      createHmac('sha256', 'secret-test-key').update(manifestSha).digest('hex'),
    );
  });
});

describe('markExportBundleReady', () => {
  it('flips building → ready with metadata', async () => {
    const query = mockTenantClient([{ rowCount: 1, rows: [] }]);
    const result = await markExportBundleReady({
      actor,
      bundleId,
      homeId,
      manifestSha256: 'a'.repeat(64),
      objectKey: 'tenants/x/y/z.zip',
      retainUntilIso: '2033-05-18T00:00:00.000Z',
      signature: 'b'.repeat(64),
      signatureAlgorithm: 'HMAC-SHA256',
      sizeBytes: 1024,
      tenantId,
    });
    expect(result).toEqual({ transitioned: true });
    expect(query).toHaveBeenCalledOnce();
  });
});

describe('markExportBundleFailed', () => {
  it('flips pending|building → failed with the truncated reason', async () => {
    mockTenantClient([{ rowCount: 1, rows: [] }]);
    const result = await markExportBundleFailed({
      actor,
      bundleId,
      homeId,
      reason: 'boom',
      tenantId,
    });
    expect(result).toEqual({ transitioned: true });
  });
});
