// Phase 4 §2 — object store for serious-incident export bundles.
//
// Mirrors the `ObjectStore` shape used by `export-pdf.ts` so the activity
// stays unit-testable while production can use Azure Blob and staging can
// retain MinIO.

import { createObjectStorage, type ObjectStorage } from '@careos/object-storage';

const DEFAULT_BUCKET = 'careos-export-bundles';

export interface BundleObjectStore {
  ensureBucket(bucket: string): Promise<void>;
  putObject(bucket: string, key: string, body: Buffer, contentType: string): Promise<void>;
}

let objectStorageSingleton: ObjectStorage | undefined;

export function getObjectStorage(): ObjectStorage {
  objectStorageSingleton ??= createObjectStorage();
  return objectStorageSingleton;
}

export function createBundleStore(store: ObjectStorage = getObjectStorage()): BundleObjectStore {
  return {
    async ensureBucket(bucket: string): Promise<void> {
      await store.ensureContainer(bucket);
    },
    async putObject(bucket, key, body, contentType): Promise<void> {
      await store.putObject(bucket, key, body, contentType);
    },
  };
}

export function bundleBucketName(): string {
  return (
    process.env.OBJECT_STORAGE_EXPORT_BUNDLES_CONTAINER ??
    process.env.MINIO_EXPORT_BUNDLES_BUCKET ??
    DEFAULT_BUCKET
  );
}

export function isMinioConfigured(): boolean {
  // Azure production always persists bundles. MinIO remains opt-in so local
  // tests without a daemon retain deterministic no-upload behavior.
  return (
    process.env.OBJECT_STORAGE_PROVIDER === 'azure' ||
    process.env.MINIO_EXPORT_BUNDLES_ENABLED === 'true'
  );
}
