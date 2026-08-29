import { ManagedIdentityCredential } from '@azure/identity';

import {
  AzureBlobObjectStorage,
  createAzureBlobServiceClient,
  type AzureBlobServiceClientLike,
} from './azure-blob.js';
import { MinioObjectStorage, createMinioClient, type MinioClientLike } from './minio.js';
import type { ObjectStorage, StorageEnvironment } from './types.js';

export type ObjectStorageProvider = 'azure' | 'minio';

export interface ObjectStorageFactoryDependencies {
  readonly createMinioClient?: (env: StorageEnvironment) => MinioClientLike;
  readonly createAzureServiceClient?: (
    accountName: string,
    clientId: string,
    endpoint: string | undefined,
  ) => AzureBlobServiceClientLike;
}

function providerFrom(env: StorageEnvironment): ObjectStorageProvider {
  const value = env.OBJECT_STORAGE_PROVIDER?.trim().toLowerCase() ?? 'minio';
  if (value !== 'azure' && value !== 'minio') {
    throw new Error('OBJECT_STORAGE_PROVIDER must be "minio" or "azure"');
  }
  return value;
}

export function createObjectStorage(
  env: StorageEnvironment = process.env,
  dependencies: ObjectStorageFactoryDependencies = {},
): ObjectStorage {
  if (providerFrom(env) === 'minio') {
    const client = (dependencies.createMinioClient ?? createMinioClient)(env);
    return new MinioObjectStorage({ client, publicEndpoint: env.MINIO_PUBLIC_ENDPOINT });
  }

  const accountName = env.AZURE_STORAGE_ACCOUNT_NAME?.trim();
  if (accountName === undefined || accountName === '') {
    throw new Error('AZURE_STORAGE_ACCOUNT_NAME is required when OBJECT_STORAGE_PROVIDER=azure');
  }
  const clientId = env.AZURE_CLIENT_ID?.trim();
  if (clientId === undefined || clientId === '') {
    throw new Error('AZURE_CLIENT_ID is required when OBJECT_STORAGE_PROVIDER=azure');
  }
  const endpoint = env.AZURE_STORAGE_BLOB_ENDPOINT?.trim() || undefined;
  const serviceClient = dependencies.createAzureServiceClient
    ? dependencies.createAzureServiceClient(accountName, clientId, endpoint)
    : createAzureBlobServiceClient(accountName, new ManagedIdentityCredential(clientId), endpoint);
  return new AzureBlobObjectStorage({ accountName, serviceClient });
}

export { AzureBlobObjectStorage, MinioObjectStorage, createAzureBlobServiceClient };
export type { AzureBlobServiceClientLike, MinioClientLike };
export type {
  ObjectMetadata,
  ObjectStorage,
  PutObjectResult,
  StorageEnvironment,
} from './types.js';
