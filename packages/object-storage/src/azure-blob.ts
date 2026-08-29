import { createHash } from 'node:crypto';

import type { TokenCredential } from '@azure/core-auth';
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  generateBlobSASQueryParameters,
  type UserDelegationKey,
} from '@azure/storage-blob';

import type { ObjectMetadata, ObjectStorage, PutObjectResult } from './types.js';

interface BlobPropertiesLike {
  readonly contentLength?: number;
  readonly contentType?: string;
  readonly etag?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

interface BlobClientLike {
  readonly url: string;
  getProperties(): Promise<BlobPropertiesLike>;
  download(): Promise<{ readonly readableStreamBody?: NodeJS.ReadableStream }>;
  deleteIfExists(options?: { readonly deleteSnapshots?: 'include' }): Promise<{
    readonly succeeded: boolean;
  }>;
}

interface BlockBlobClientLike {
  uploadData(
    body: Buffer,
    options: {
      readonly blobHTTPHeaders: { readonly blobContentType: string };
      readonly conditions: { readonly ifNoneMatch: '*' };
      readonly metadata: Readonly<Record<string, string>>;
    },
  ): Promise<{ readonly etag?: string }>;
}

interface ContainerClientLike {
  createIfNotExists(): Promise<{ readonly succeeded: boolean }>;
  getBlobClient(key: string): BlobClientLike;
  getBlockBlobClient(key: string): BlockBlobClientLike;
}

export interface AzureBlobServiceClientLike {
  getContainerClient(container: string): ContainerClientLike;
  getUserDelegationKey(startsOn: Date, expiresOn: Date): Promise<unknown>;
}

export interface AzureBlobObjectStorageOptions {
  readonly accountName: string;
  readonly serviceClient: AzureBlobServiceClientLike;
  readonly now?: () => Date;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const value = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === 'string' ? value : undefined;
}

function isNotFound(error: unknown): boolean {
  return statusCode(error) === 404 || errorCode(error) === 'BlobNotFound';
}

function isPreconditionFailure(error: unknown): boolean {
  return statusCode(error) === 412 || errorCode(error) === 'ConditionNotMet';
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export class AzureBlobObjectStorage implements ObjectStorage {
  private readonly now: () => Date;

  constructor(private readonly options: AzureBlobObjectStorageOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async ensureContainer(container: string): Promise<void> {
    await this.options.serviceClient.getContainerClient(container).createIfNotExists();
  }

  presignGet(container: string, key: string, expirySeconds: number): Promise<string> {
    return this.presign(container, key, expirySeconds, 'r');
  }

  presignPut(container: string, key: string, expirySeconds: number): Promise<string> {
    return this.presign(container, key, expirySeconds, 'cw');
  }

  async statObject(container: string, key: string): Promise<ObjectMetadata> {
    const properties = await this.options.serviceClient
      .getContainerClient(container)
      .getBlobClient(key)
      .getProperties();
    return {
      etag: properties.etag,
      mimeType: properties.contentType,
      sizeBytes: properties.contentLength ?? 0,
    };
  }

  async getObject(container: string, key: string): Promise<NodeJS.ReadableStream> {
    const response = await this.options.serviceClient
      .getContainerClient(container)
      .getBlobClient(key)
      .download();
    if (response.readableStreamBody === undefined) {
      throw new Error(`azure-blob: ${container}/${key} returned no response body`);
    }
    return response.readableStreamBody;
  }

  async putObject(
    container: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<PutObjectResult> {
    const containerClient = this.options.serviceClient.getContainerClient(container);
    const blobClient = containerClient.getBlobClient(key);
    const digest = sha256(body);
    const existing = await this.propertiesIfPresent(blobClient);
    if (existing !== undefined) return this.reconcile(container, key, body, digest, existing);

    try {
      const result = await containerClient.getBlockBlobClient(key).uploadData(body, {
        blobHTTPHeaders: { blobContentType: contentType },
        conditions: { ifNoneMatch: '*' },
        metadata: { careossha256: digest },
      });
      return { etag: result.etag, reconciled: false };
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const raced = await blobClient.getProperties();
      return this.reconcile(container, key, body, digest, raced);
    }
  }

  async objectExists(container: string, key: string): Promise<boolean> {
    try {
      await this.options.serviceClient
        .getContainerClient(container)
        .getBlobClient(key)
        .getProperties();
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async deleteObject(container: string, key: string): Promise<void> {
    await this.options.serviceClient
      .getContainerClient(container)
      .getBlobClient(key)
      .deleteIfExists({ deleteSnapshots: 'include' });
    if (await this.objectExists(container, key)) {
      throw new Error(`azure-blob: ${container}/${key} still exists after deletion`);
    }
  }

  private async presign(
    container: string,
    key: string,
    expirySeconds: number,
    permissions: string,
  ): Promise<string> {
    const startsOn = new Date(this.now().getTime() - 5 * 60 * 1000);
    const expiresOn = new Date(this.now().getTime() + expirySeconds * 1000);
    const delegationKey = (await this.options.serviceClient.getUserDelegationKey(
      startsOn,
      expiresOn,
    )) as UserDelegationKey;
    const query = generateBlobSASQueryParameters(
      {
        blobName: key,
        containerName: container,
        expiresOn,
        permissions: BlobSASPermissions.parse(permissions),
        protocol: SASProtocol.Https,
        startsOn,
      },
      delegationKey,
      this.options.accountName,
    ).toString();
    const blobUrl = this.options.serviceClient.getContainerClient(container).getBlobClient(key).url;
    return `${blobUrl}?${query}`;
  }

  private async propertiesIfPresent(
    blobClient: BlobClientLike,
  ): Promise<BlobPropertiesLike | undefined> {
    try {
      return await blobClient.getProperties();
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private reconcile(
    container: string,
    key: string,
    body: Buffer,
    digest: string,
    properties: BlobPropertiesLike,
  ): PutObjectResult {
    if (properties.contentLength === body.length && properties.metadata?.careossha256 === digest) {
      return { etag: properties.etag, reconciled: true };
    }
    throw new Error(`azure-blob: refusing to overwrite ${container}/${key} with different content`);
  }
}

export function createAzureBlobServiceClient(
  accountName: string,
  credential: TokenCredential,
  endpoint = `https://${accountName}.blob.core.windows.net`,
): AzureBlobServiceClientLike {
  return new BlobServiceClient(endpoint, credential, {
    retryOptions: {
      maxTries: 5,
      retryDelayInMs: 800,
      maxRetryDelayInMs: 8000,
    },
  });
}
