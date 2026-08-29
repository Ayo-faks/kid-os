// Short-lived URLs and metadata verification for persisted CareOS objects.
//
// We deliberately don't persist signed URLs on the workflow state — they
// expire, so we re-sign on demand from the immutable objectKey.

import { createObjectStorage, type ObjectStorage } from '@careos/object-storage';
import { Injectable } from '@nestjs/common';

const DEFAULT_BUCKET = 'careos-incidents';
const DEFAULT_DOCUMENTS_BUCKET = 'careos-documents';
const DEFAULT_EXPORT_BUNDLES_BUCKET = 'careos-export-bundles';
const DEFAULT_EXPIRY_SECONDS = 5 * 60;

export interface DocumentObjectMetadata {
  readonly mimeType: string | undefined;
  readonly sizeBytes: number;
}

@Injectable()
export class StorageService {
  private readonly store: ObjectStorage = createObjectStorage();
  readonly incidentsBucket =
    process.env.OBJECT_STORAGE_INCIDENTS_CONTAINER ??
    process.env.MINIO_INCIDENTS_BUCKET ??
    DEFAULT_BUCKET;
  readonly documentsBucket =
    process.env.OBJECT_STORAGE_DOCUMENTS_CONTAINER ??
    process.env.MINIO_DOCUMENTS_BUCKET ??
    DEFAULT_DOCUMENTS_BUCKET;
  readonly exportBundlesBucket =
    process.env.OBJECT_STORAGE_EXPORT_BUNDLES_CONTAINER ??
    process.env.MINIO_EXPORT_BUNDLES_BUCKET ??
    DEFAULT_EXPORT_BUNDLES_BUCKET;

  presignedIncidentDownload(
    objectKey: string,
    expirySeconds: number = DEFAULT_EXPIRY_SECONDS,
  ): Promise<string> {
    return this.store.presignGet(this.incidentsBucket, objectKey, expirySeconds);
  }

  presignedDocumentUpload(
    objectKey: string,
    expirySeconds: number = DEFAULT_EXPIRY_SECONDS,
  ): Promise<string> {
    return this.store.presignPut(this.documentsBucket, objectKey, expirySeconds);
  }

  async statDocument(objectKey: string): Promise<DocumentObjectMetadata> {
    const stat = await this.store.statObject(this.documentsBucket, objectKey);
    return { mimeType: stat.mimeType, sizeBytes: stat.sizeBytes };
  }

  presignedExportBundleDownload(
    objectKey: string,
    expirySeconds: number = DEFAULT_EXPIRY_SECONDS,
  ): Promise<string> {
    return this.store.presignGet(this.exportBundlesBucket, objectKey, expirySeconds);
  }
}
