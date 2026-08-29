import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const extractMocks = vi.hoisted(() => ({
  extractDocument: vi.fn(),
  loadDocumentForExtraction: vi.fn(),
}));
const documentMocks = vi.hoisted(() => ({
  markDocumentExtracted: vi.fn(),
  markDocumentExtracting: vi.fn(),
  markDocumentFailed: vi.fn(),
}));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/documents-extract.js', () => extractMocks);
vi.mock('../../activities/documents.js', () => documentMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import { processDocumentIngestActivity } from './document-ingest.activities.js';

const context = new ActivityContext('document-ingest-test', 1);
const input = {
  actor: {
    correlationId: 'corr-document',
    kind: 'user' as const,
    userId: '33333333-3333-4333-8333-333333333333',
  },
  documentId: '44444444-4444-4444-8444-444444444444',
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('Durable Document Ingest composite activity', () => {
  beforeEach(() => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    withTenantContextMock.mockImplementation(
      (_context: unknown, callback: (client: { query: typeof query }) => Promise<unknown>) =>
        callback({ query }),
    );
    documentMocks.markDocumentExtracting.mockResolvedValue({
      status: 'extracting',
      transitioned: true,
    });
    extractMocks.loadDocumentForExtraction.mockResolvedValue({
      mimeType: 'application/pdf',
      objectKey: 'tenants/t/homes/h/documents/id/care-plan.pdf',
      originalFilename: 'Care plan.pdf',
    });
    extractMocks.extractDocument.mockResolvedValue({ extractedText: '# Private care plan' });
    documentMocks.markDocumentExtracted.mockResolvedValue({
      status: 'extracted',
      transitioned: true,
    });
    documentMocks.markDocumentFailed.mockResolvedValue({
      status: 'failed',
      transitioned: true,
    });
  });

  afterEach(() => vi.clearAllMocks());

  it('persists extracted text but returns only an operational terminal result', async () => {
    const result = await processDocumentIngestActivity(context, input);

    expect(documentMocks.markDocumentExtracted).toHaveBeenCalledWith(
      expect.objectContaining({ extractedText: '# Private care plan' }),
    );
    expect(result).toEqual({ documentId: input.documentId, status: 'extracted' });
    expect(JSON.stringify(result)).not.toContain('Private care plan');
    expect(JSON.stringify(result)).not.toContain('care-plan.pdf');
  });

  it('records Docling unavailability without returning free-form failure prose', async () => {
    extractMocks.extractDocument.mockResolvedValue({
      extractedText: '',
      reason: 'docling-disabled',
    });

    const result = await processDocumentIngestActivity(context, input);

    expect(documentMocks.markDocumentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: 'docling-unavailable' }),
    );
    expect(result).toEqual({
      documentId: input.documentId,
      outcomeCode: 'docling-unavailable',
      status: 'failed',
    });
  });

  it('reconciles a lost acknowledgement after extraction without extracting twice', async () => {
    documentMocks.markDocumentExtracting.mockResolvedValue({
      status: 'extracted',
      transitioned: false,
    });

    await expect(processDocumentIngestActivity(context, input)).resolves.toEqual({
      documentId: input.documentId,
      status: 'extracted',
    });
    expect(extractMocks.loadDocumentForExtraction).not.toHaveBeenCalled();
    expect(extractMocks.extractDocument).not.toHaveBeenCalled();
  });

  it('stores provider failure detail in Postgres but exposes only a closed outcome code', async () => {
    extractMocks.extractDocument.mockRejectedValue(
      new Error('Docling response included resident narrative'),
    );

    const result = await processDocumentIngestActivity(context, input);

    expect(documentMocks.markDocumentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: 'Docling response included resident narrative' }),
    );
    expect(result).toEqual({
      documentId: input.documentId,
      outcomeCode: 'extraction-failed',
      status: 'failed',
    });
    expect(JSON.stringify(result)).not.toContain('resident narrative');
  });
});
