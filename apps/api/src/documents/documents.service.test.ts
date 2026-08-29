import { describe, expect, it, vi } from 'vitest';

import { DocumentsService } from './documents.service.js';

const context = {
  actor: {
    correlationId: 'corr-documents',
    kind: 'user' as const,
    userId: '33333333-3333-4333-8333-333333333333',
  },
  correlationId: 'corr-documents',
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
  uploaderUserId: '33333333-3333-4333-8333-333333333333',
};

function harness(stat = { mimeType: 'application/pdf', sizeBytes: 128 }): {
  readonly executeRaw: ReturnType<typeof vi.fn>;
  readonly queryRaw: ReturnType<typeof vi.fn>;
  readonly service: DocumentsService;
  readonly storage: {
    readonly presignedDocumentUpload: ReturnType<typeof vi.fn>;
    readonly statDocument: ReturnType<typeof vi.fn>;
  };
  readonly temporal: { readonly startDocIngestWorkflow: ReturnType<typeof vi.fn> };
} {
  const executeRaw = vi.fn().mockResolvedValue(1);
  const queryRaw = vi.fn().mockResolvedValue([]);
  const transaction = { $executeRaw: executeRaw, $queryRaw: queryRaw };
  const prisma = {
    withTenantContext: vi.fn((_context: unknown, callback: (tx: typeof transaction) => unknown) =>
      Promise.resolve(callback(transaction)),
    ),
  };
  const temporal = {
    startDocIngestWorkflow: vi.fn().mockResolvedValue({ workflowId: 'doc-ingest-test' }),
  };
  const storage = {
    presignedDocumentUpload: vi.fn().mockResolvedValue('https://localhost/careos-documents/key'),
    statDocument: vi.fn().mockResolvedValue(stat),
  };
  return {
    executeRaw,
    queryRaw,
    service: new DocumentsService(
      prisma as unknown as ConstructorParameters<typeof DocumentsService>[0],
      temporal,
      storage as unknown as ConstructorParameters<typeof DocumentsService>[2],
    ),
    storage,
    temporal,
  };
}

describe('DocumentsService upload boundary', () => {
  it('lists the latest RLS-visible documents with serialized timestamps', async () => {
    const { queryRaw, service } = harness();
    queryRaw.mockResolvedValue([
      {
        createdAt: new Date('2026-07-20T09:00:00.000Z'),
        failureReason: null,
        id: '44444444-4444-4444-8444-444444444444',
        mimeType: 'text/plain',
        objectKey: 'tenants/test/document.txt',
        originalFilename: 'document.txt',
        sizeBytes: 128,
        status: 'extracted',
        updatedAt: new Date('2026-07-20T09:01:00.000Z'),
      },
    ]);

    await expect(service.list(context)).resolves.toEqual({
      documents: [
        {
          createdAt: '2026-07-20T09:00:00.000Z',
          failureReason: null,
          id: '44444444-4444-4444-8444-444444444444',
          mimeType: 'text/plain',
          objectKey: 'tenants/test/document.txt',
          originalFilename: 'document.txt',
          sizeBytes: 128,
          status: 'extracted',
          updatedAt: '2026-07-20T09:01:00.000Z',
        },
      ],
    });
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('generates a scoped object key and short-lived presigned PUT URL', async () => {
    const { service, storage } = harness();

    const result = await service.presign(
      {
        mime_type: 'application/pdf',
        original_filename: '../Care plan.pdf',
        size_bytes: 128,
      },
      context,
    );

    expect(result.objectKey).toMatch(
      /^tenants\/11111111-1111-4111-8111-111111111111\/homes\/22222222-2222-4222-8222-222222222222\/documents\/[0-9a-f-]+\/Care-plan\.pdf$/,
    );
    expect(storage.presignedDocumentUpload).toHaveBeenCalledWith(result.objectKey, 300);
    expect(result.uploadUrl).toBe('https://localhost/careos-documents/key');
  });

  it('refuses registration when MinIO metadata does not match the declared upload', async () => {
    const { executeRaw, service, temporal } = harness({
      mimeType: 'application/pdf',
      sizeBytes: 127,
    });

    await expect(
      service.register(
        {
          mime_type: 'application/pdf',
          object_key: `tenants/${context.tenantId}/homes/${context.homeId}/documents/44444444-4444-4444-8444-444444444444/Care-plan.pdf`,
          original_filename: 'Care plan.pdf',
          size_bytes: 128,
        },
        context,
      ),
    ).rejects.toThrow(/metadata does not match/i);

    expect(executeRaw).not.toHaveBeenCalled();
    expect(temporal.startDocIngestWorkflow).not.toHaveBeenCalled();
  });

  it('reuses the presigned document identity across registration retries', async () => {
    const { executeRaw, service, temporal } = harness();
    const documentId = '44444444-4444-4444-8444-444444444444';
    const dto = {
      mime_type: 'application/pdf' as const,
      object_key: `tenants/${context.tenantId}/homes/${context.homeId}/documents/${documentId}/Care-plan.pdf`,
      original_filename: 'Care plan.pdf',
      size_bytes: 128,
    };

    await service.register(dto, context);
    await service.register(dto, context);

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(temporal.startDocIngestWorkflow).toHaveBeenCalledTimes(2);
    expect(temporal.startDocIngestWorkflow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ documentId }),
    );
  });
});
