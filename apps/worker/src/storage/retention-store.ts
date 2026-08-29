import type { ObjectStorage } from '@careos/object-storage';

import { getObjectStorage } from './bundle-store.js';

const DEFAULT_ATTACHMENTS_BUCKET = 'attachments';

export interface RetentionObjectStore {
  objectExists(bucket: string, key: string): Promise<boolean>;
  removeObject(bucket: string, key: string): Promise<void>;
}

export function createRetentionObjectStore(
  store: ObjectStorage = getObjectStorage(),
): RetentionObjectStore {
  return {
    async objectExists(bucket, key): Promise<boolean> {
      return store.objectExists(bucket, key);
    },
    async removeObject(bucket, key): Promise<void> {
      await store.deleteObject(bucket, key);
    },
  };
}

export function attachmentsBucketName(): string {
  return (
    process.env.OBJECT_STORAGE_ATTACHMENTS_CONTAINER ??
    process.env.MINIO_ATTACHMENTS_BUCKET ??
    DEFAULT_ATTACHMENTS_BUCKET
  );
}
