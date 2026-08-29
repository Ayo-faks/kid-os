import { afterEach, describe, expect, it, vi } from 'vitest';

import { StorageService } from './storage.service.js';

describe('StorageService document uploads', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('mints browser-reachable document upload URLs through the public path prefix', async () => {
    vi.stubEnv('MINIO_PUBLIC_ENDPOINT', 'https://localhost/minio');
    const service = new StorageService();

    const result = new URL(
      await service.presignedDocumentUpload('tenants/tenant/homes/home/documents/id/file.pdf'),
    );

    expect(result.origin).toBe('https://localhost');
    expect(result.pathname).toBe(
      '/minio/careos-documents/tenants/tenant/homes/home/documents/id/file.pdf',
    );
    expect(result.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(result.searchParams.has('X-Amz-Signature')).toBe(true);
  });
});
