import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  AzureBlobObjectStorage,
  MinioObjectStorage,
  createObjectStorage,
  type AzureBlobServiceClientLike,
  type MinioClientLike,
} from './index.js';

function minioClient(overrides: Partial<MinioClientLike> = {}): MinioClientLike {
  return {
    bucketExists: vi.fn().mockResolvedValue(true),
    getObject: vi.fn().mockResolvedValue(Readable.from([])),
    makeBucket: vi.fn().mockResolvedValue(undefined),
    presignedGetObject: vi.fn((_bucket, key) => Promise.resolve(`https://minio.test/${key}`)),
    presignedPutObject: vi.fn((_bucket, key) => Promise.resolve(`https://minio.test/${key}`)),
    putObject: vi.fn().mockResolvedValue({ etag: 'etag', versionId: null }),
    removeObject: vi.fn().mockResolvedValue(undefined),
    statObject: vi.fn().mockResolvedValue({ etag: 'etag', metaData: {}, size: 1 }),
    ...overrides,
  };
}

describe('createObjectStorage', () => {
  it('uses MinIO by default for local and staging compatibility', () => {
    const store = createObjectStorage(
      { OBJECT_STORAGE_PROVIDER: undefined },
      { createMinioClient: () => minioClient() },
    );

    expect(store).toBeInstanceOf(MinioObjectStorage);
  });

  it('requires a deterministic managed identity for Azure Blob', () => {
    expect(() =>
      createObjectStorage({
        OBJECT_STORAGE_PROVIDER: 'azure',
        AZURE_STORAGE_ACCOUNT_NAME: 'stcareosprduks',
      }),
    ).toThrow(/AZURE_CLIENT_ID/);
  });
});

describe('MinioObjectStorage', () => {
  it('preserves the public path prefix on presigned browser uploads', async () => {
    const store = new MinioObjectStorage({
      client: minioClient({
        presignedPutObject: vi
          .fn()
          .mockResolvedValue('https://localhost/bucket/key?signature=test'),
      }),
      publicEndpoint: 'https://localhost/minio',
    });

    await expect(store.presignPut('documents', 'tenant/document.pdf', 300)).resolves.toBe(
      'https://localhost/minio/bucket/key?signature=test',
    );
  });
});

describe('AzureBlobObjectStorage', () => {
  it('mints HTTPS user-delegation URLs for browser uploads and downloads', async () => {
    const getUserDelegationKey = vi.fn().mockResolvedValue({
      signedExpiry: '2030-01-01T01:00:00Z',
      signedObjectId: 'object-id',
      signedService: 'b',
      signedStart: '2030-01-01T00:00:00Z',
      signedTenantId: 'tenant-id',
      signedVersion: '2025-01-05',
      value: Buffer.from('delegation-key').toString('base64'),
    });
    const serviceClient: AzureBlobServiceClientLike = {
      getContainerClient: () => ({
        createIfNotExists: vi.fn().mockResolvedValue({ succeeded: false }),
        getBlobClient: () => ({
          deleteIfExists: vi.fn().mockResolvedValue({ succeeded: true }),
          download: vi.fn().mockResolvedValue({ readableStreamBody: Readable.from([]) }),
          getProperties: vi.fn(),
          url: 'https://stcareosprduks.blob.core.windows.net/documents/file.pdf',
        }),
        getBlockBlobClient: () => ({ uploadData: vi.fn() }),
      }),
      getUserDelegationKey,
    };
    const store = new AzureBlobObjectStorage({
      accountName: 'stcareosprduks',
      now: () => new Date('2030-01-01T00:10:00Z'),
      serviceClient,
    });

    const upload = new URL(await store.presignPut('documents', 'file.pdf', 300));
    const download = new URL(await store.presignGet('documents', 'file.pdf', 300));
    expect(upload.protocol).toBe('https:');
    expect(upload.searchParams.get('sp')).toContain('c');
    expect(upload.searchParams.get('sp')).toContain('w');
    expect(download.searchParams.get('sp')).toBe('r');
    expect(getUserDelegationKey).toHaveBeenCalledTimes(2);
  });

  it('returns blob metadata and streams the stored object', async () => {
    const readable = Readable.from([Buffer.from('document')]);
    const serviceClient: AzureBlobServiceClientLike = {
      getContainerClient: () => ({
        createIfNotExists: vi.fn().mockResolvedValue({ succeeded: false }),
        getBlobClient: () => ({
          deleteIfExists: vi.fn().mockResolvedValue({ succeeded: true }),
          download: vi.fn().mockResolvedValue({ readableStreamBody: readable }),
          getProperties: vi.fn().mockResolvedValue({
            contentLength: 8,
            contentType: 'application/pdf',
            etag: 'etag-1',
          }),
          url: 'https://stcareosprduks.blob.core.windows.net/documents/file.pdf',
        }),
        getBlockBlobClient: () => ({ uploadData: vi.fn() }),
      }),
      getUserDelegationKey: vi.fn(),
    };
    const store = new AzureBlobObjectStorage({
      accountName: 'stcareosprduks',
      serviceClient,
    });

    await expect(store.statObject('documents', 'file.pdf')).resolves.toEqual({
      etag: 'etag-1',
      mimeType: 'application/pdf',
      sizeBytes: 8,
    });
    await expect(store.getObject('documents', 'file.pdf')).resolves.toBe(readable);
  });

  it('verifies an object is absent after deletion', async () => {
    const getProperties = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('missing'), { statusCode: 404 }));
    const deleteIfExists = vi.fn().mockResolvedValue({ succeeded: true });
    const serviceClient: AzureBlobServiceClientLike = {
      getContainerClient: () => ({
        createIfNotExists: vi.fn().mockResolvedValue({ succeeded: false }),
        getBlobClient: () => ({
          deleteIfExists,
          download: vi.fn().mockResolvedValue({ readableStreamBody: Readable.from([]) }),
          getProperties,
          url: 'https://stcareosprduks.blob.core.windows.net/attachments/file',
        }),
        getBlockBlobClient: () => ({ uploadData: vi.fn() }),
      }),
      getUserDelegationKey: vi.fn(),
    };
    const store = new AzureBlobObjectStorage({
      accountName: 'stcareosprduks',
      serviceClient,
    });

    await expect(store.deleteObject('attachments', 'file')).resolves.toBeUndefined();
    expect(deleteIfExists).toHaveBeenCalledWith({ deleteSnapshots: 'include' });
    expect(getProperties).toHaveBeenCalledOnce();
  });

  it('reconciles an identical retry without uploading the body twice', async () => {
    const body = Buffer.from('signed bundle');
    const contentSha256 = createHash('sha256').update(body).digest('hex');
    const uploadData = vi.fn().mockResolvedValue({ etag: 'new-etag' });
    const getProperties = vi.fn().mockResolvedValue({
      contentLength: body.length,
      contentType: 'application/zip',
      etag: 'existing-etag',
      metadata: { careossha256: contentSha256 },
    });
    const serviceClient: AzureBlobServiceClientLike = {
      getContainerClient: () => ({
        createIfNotExists: vi.fn().mockResolvedValue({ succeeded: false }),
        getBlobClient: () => ({
          deleteIfExists: vi.fn().mockResolvedValue({ succeeded: true }),
          download: vi.fn().mockResolvedValue({ readableStreamBody: Readable.from([]) }),
          getProperties,
          url: 'https://stcareosprduks.blob.core.windows.net/exports/bundle.zip',
        }),
        getBlockBlobClient: () => ({ uploadData }),
      }),
      getUserDelegationKey: vi.fn().mockResolvedValue({
        signedExpiry: new Date('2030-01-01T01:00:00Z'),
        signedObjectId: 'object-id',
        signedService: 'b',
        signedStart: new Date('2030-01-01T00:00:00Z'),
        signedTenantId: 'tenant-id',
        signedVersion: '2025-01-05',
        value: 'delegation-key',
      }),
    };
    const store = new AzureBlobObjectStorage({
      accountName: 'stcareosprduks',
      serviceClient,
    });

    await expect(
      store.putObject('exports', 'bundle.zip', body, 'application/zip'),
    ).resolves.toEqual({ etag: 'existing-etag', reconciled: true });
    expect(uploadData).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a stable key with different content', async () => {
    const serviceClient: AzureBlobServiceClientLike = {
      getContainerClient: () => ({
        createIfNotExists: vi.fn().mockResolvedValue({ succeeded: false }),
        getBlobClient: () => ({
          deleteIfExists: vi.fn().mockResolvedValue({ succeeded: true }),
          download: vi.fn().mockResolvedValue({ readableStreamBody: Readable.from([]) }),
          getProperties: vi.fn().mockResolvedValue({
            contentLength: 5,
            etag: 'existing-etag',
            metadata: { careossha256: 'different' },
          }),
          url: 'https://stcareosprduks.blob.core.windows.net/exports/bundle.zip',
        }),
        getBlockBlobClient: () => ({ uploadData: vi.fn() }),
      }),
      getUserDelegationKey: vi.fn(),
    };
    const store = new AzureBlobObjectStorage({
      accountName: 'stcareosprduks',
      serviceClient,
    });

    await expect(
      store.putObject('exports', 'bundle.zip', Buffer.from('new body'), 'application/zip'),
    ).rejects.toThrow(/different content/);
  });
});
