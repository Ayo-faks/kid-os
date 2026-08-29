import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withTenantContext: withTenantContextMock,
}));

import { markDocumentExtracted, markDocumentExtracting, markDocumentFailed } from './documents.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const documentId = '44444444-4444-4444-8444-444444444444';
const correlationId = 'corr-doc-test';

const actor = {
  correlationId,
  kind: 'user' as const,
  userId: '55555555-5555-4555-8555-555555555555',
};

afterEach(() => {
  vi.clearAllMocks();
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

describe('markDocumentExtracting', () => {
  it('flips uploaded → extracting and reports the new status', async () => {
    mockTenantClient([
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ status: 'extracting' }] },
    ]);

    const result = await markDocumentExtracting({
      actor,
      documentId,
      homeId,
      tenantId,
    });

    expect(result).toEqual({ status: 'extracting', transitioned: true });
    expect(withTenantContextMock).toHaveBeenCalledWith(
      { actor, homeId, tenantId },
      expect.any(Function),
    );
  });

  it('returns transitioned=false when the status is no longer uploaded', async () => {
    mockTenantClient([
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ status: 'extracted' }] },
    ]);

    const result = await markDocumentExtracting({
      actor,
      documentId,
      homeId,
      tenantId,
    });

    expect(result).toEqual({ status: 'extracted', transitioned: false });
  });

  it('falls back to uploaded when the row is missing', async () => {
    mockTenantClient([
      { rowCount: 0, rows: [] },
      { rowCount: 0, rows: [] },
    ]);

    const result = await markDocumentExtracting({
      actor,
      documentId,
      homeId,
      tenantId,
    });

    expect(result).toEqual({ status: 'uploaded', transitioned: false });
  });
});

describe('markDocumentExtracted', () => {
  it('flips extracting → extracted and persists the extracted text', async () => {
    const query = mockTenantClient([
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ status: 'extracted' }] },
    ]);

    const result = await markDocumentExtracted({
      actor,
      documentId,
      extractedText: 'hello world',
      homeId,
      tenantId,
    });

    expect(result).toEqual({ status: 'extracted', transitioned: true });
    const [, params] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(params).toEqual([documentId, 'hello world']);
  });

  it('returns transitioned=false when not in extracting state', async () => {
    mockTenantClient([
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ status: 'failed' }] },
    ]);

    const result = await markDocumentExtracted({
      actor,
      documentId,
      extractedText: '',
      homeId,
      tenantId,
    });

    expect(result.transitioned).toBe(false);
    expect(result.status).toBe('failed');
  });
});

describe('markDocumentFailed', () => {
  it('flips to failed from either uploaded or extracting and stores the reason', async () => {
    const query = mockTenantClient([
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ status: 'failed' }] },
    ]);

    const result = await markDocumentFailed({
      actor,
      documentId,
      failureReason: 'docling-timeout',
      homeId,
      tenantId,
    });

    expect(result).toEqual({ status: 'failed', transitioned: true });
    const [, params] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(params).toEqual([documentId, 'docling-timeout']);
  });

  it('does not transition when the document is already terminal', async () => {
    mockTenantClient([
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ status: 'extracted' }] },
    ]);

    const result = await markDocumentFailed({
      actor,
      documentId,
      failureReason: 'should-be-ignored',
      homeId,
      tenantId,
    });

    expect(result).toEqual({ status: 'extracted', transitioned: false });
  });
});
