import { Readable } from 'node:stream';

import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());
const getObjectMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withTenantContext: withTenantContextMock,
}));

vi.mock('../storage/bundle-store.js', () => ({
  getObjectStorage: () => ({ getObject: getObjectMock }),
}));

import { extractDocument, loadDocumentForExtraction } from './documents-extract.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const actor = {
  correlationId: 'corr-docs-extract',
  kind: 'system' as const,
  userId: null,
};

function mockTenantQuery(rows: readonly unknown[]) {
  const query = vi.fn().mockResolvedValue({ rowCount: rows.length, rows });
  withTenantContextMock.mockImplementation(
    (_context: unknown, cb: (client: PoolClient) => Promise<unknown>) =>
      cb({ query } as unknown as PoolClient),
  );
  return query;
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DOCLING_URL;
});

describe('loadDocumentForExtraction', () => {
  it('returns objectKey + mime + filename under tenant context', async () => {
    mockTenantQuery([
      {
        mimeType: 'application/pdf',
        objectKey: 'tenants/x/docs/a.pdf',
        originalFilename: 'a.pdf',
      },
    ]);
    const result = await loadDocumentForExtraction({
      actor,
      documentId,
      homeId,
      tenantId,
    });
    expect(result).toEqual({
      mimeType: 'application/pdf',
      objectKey: 'tenants/x/docs/a.pdf',
      originalFilename: 'a.pdf',
    });
  });

  it('throws when the row is not visible', async () => {
    mockTenantQuery([]);
    await expect(
      loadDocumentForExtraction({ actor, documentId, homeId, tenantId }),
    ).rejects.toThrow(/not found/);
  });
});

describe('extractDocument', () => {
  it('short-circuits with docling-disabled when DOCLING_URL is unset', async () => {
    const result = await extractDocument({
      actor,
      documentId,
      homeId,
      mimeType: 'application/pdf',
      objectKey: 'k',
      originalFilename: 'a.pdf',
      tenantId,
    });
    expect(result).toEqual({ extractedText: '', reason: 'docling-disabled' });
    expect(getObjectMock).not.toHaveBeenCalled();
  });

  it('treats `change-me` DOCLING_URL as disabled', async () => {
    process.env.DOCLING_URL = 'change-me';
    const result = await extractDocument({
      actor,
      documentId,
      homeId,
      mimeType: 'application/pdf',
      objectKey: 'k',
      originalFilename: 'a.pdf',
      tenantId,
    });
    expect(result.reason).toBe('docling-disabled');
  });

  it('posts the blob to docling and returns the markdown content', async () => {
    process.env.DOCLING_URL = 'http://docling:5001/';
    getObjectMock.mockResolvedValue(Readable.from([Buffer.from('PDF-bytes')]));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ document: { md_content: '# Hello' } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );

    const result = await extractDocument({
      actor,
      documentId,
      homeId,
      mimeType: 'application/pdf',
      objectKey: 'tenants/x/docs/a.pdf',
      originalFilename: 'a.pdf',
      tenantId,
    });

    expect(result).toEqual({ extractedText: '# Hello' });
    expect(getObjectMock).toHaveBeenCalledWith('careos-documents', 'tenants/x/docs/a.pdf');
    const url = fetchSpy.mock.calls[0]?.[0];
    expect(url).toBe('http://docling:5001/v1/convert/file');
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    fetchSpy.mockRestore();
  });

  it('throws when docling returns a non-2xx response', async () => {
    process.env.DOCLING_URL = 'http://docling:5001';
    getObjectMock.mockResolvedValue(Readable.from([Buffer.from('x')]));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(
      extractDocument({
        actor,
        documentId,
        homeId,
        mimeType: 'application/pdf',
        objectKey: 'k',
        originalFilename: 'a.pdf',
        tenantId,
      }),
    ).rejects.toThrow(/docling-serve 500/);
    fetchSpy.mockRestore();
  });

  it('truncates extracted text past 1MB', async () => {
    process.env.DOCLING_URL = 'http://docling:5001';
    getObjectMock.mockResolvedValue(Readable.from([Buffer.from('x')]));
    const oversized = 'a'.repeat(1_500_000);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ document: { md_content: oversized } }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
    const result = await extractDocument({
      actor,
      documentId,
      homeId,
      mimeType: 'application/pdf',
      objectKey: 'k',
      originalFilename: 'a.pdf',
      tenantId,
    });
    expect(Buffer.byteLength(result.extractedText, 'utf8')).toBe(1_000_000);
    fetchSpy.mockRestore();
  });
});

beforeEach(() => {
  // keep noise out of test output
});
