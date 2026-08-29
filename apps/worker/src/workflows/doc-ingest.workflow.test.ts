import { beforeEach, describe, expect, it, vi } from 'vitest';

const activities = vi.hoisted(() => ({
  extractDocument: vi.fn(),
  loadDocumentForExtraction: vi.fn(),
  markDocumentExtracted: vi.fn(),
  markDocumentExtracting: vi.fn(),
  markDocumentFailed: vi.fn(),
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: vi.fn(() => activities),
}));

import { DocIngestWorkflow } from './doc-ingest.workflow.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  activities.markDocumentExtracting.mockResolvedValue({
    status: 'extracting',
    transitioned: true,
  });
  activities.loadDocumentForExtraction.mockResolvedValue({
    mimeType: 'application/pdf',
    objectKey: 'documents/care-plan.pdf',
    originalFilename: 'Care plan.pdf',
  });
  activities.extractDocument.mockResolvedValue({ extractedText: '# Care plan' });
  activities.markDocumentExtracted.mockResolvedValue({
    status: 'extracted',
    transitioned: true,
  });
  activities.markDocumentFailed.mockResolvedValue({ status: 'failed', transitioned: true });
});

describe('DocIngestWorkflow', () => {
  it('persists successful extraction text', async () => {
    await expect(DocIngestWorkflow(input)).resolves.toEqual({ status: 'extracted' });
    expect(activities.markDocumentExtracted).toHaveBeenCalledWith(
      expect.objectContaining({ extractedText: '# Care plan' }),
    );
    expect(activities.markDocumentFailed).not.toHaveBeenCalled();
  });

  it('records an unavailable failure instead of empty extracted success when Docling is disabled', async () => {
    activities.extractDocument.mockResolvedValue({
      extractedText: '',
      reason: 'docling-disabled',
    });

    await expect(DocIngestWorkflow(input)).resolves.toEqual({ status: 'failed' });
    expect(activities.markDocumentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: 'docling-unavailable' }),
    );
    expect(activities.markDocumentExtracted).not.toHaveBeenCalled();
  });

  it('records extraction errors as failed', async () => {
    activities.extractDocument.mockRejectedValue(
      new Error('Activity task failed', { cause: new Error('Docling request failed') }),
    );

    await expect(DocIngestWorkflow(input)).resolves.toEqual({ status: 'failed' });
    expect(activities.markDocumentFailed).toHaveBeenCalledWith(
      expect.objectContaining({ failureReason: 'Docling request failed' }),
    );
    expect(activities.markDocumentExtracted).not.toHaveBeenCalled();
  });
});
