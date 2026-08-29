import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';

import { Client as MinioClient, type ClientOptions } from 'minio';

import type {
  ObjectMetadata,
  ObjectStorage,
  PutObjectResult,
  StorageEnvironment,
} from './types.js';

export interface MinioClientLike {
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string): Promise<unknown>;
  presignedGetObject(bucket: string, key: string, expirySeconds?: number): Promise<string>;
  presignedPutObject(bucket: string, key: string, expirySeconds?: number): Promise<string>;
  statObject(
    bucket: string,
    key: string,
  ): Promise<{
    readonly etag?: string;
    readonly metaData?: Readonly<Record<string, unknown>>;
    readonly size: number;
  }>;
  getObject(bucket: string, key: string): Promise<NodeJS.ReadableStream>;
  putObject(
    bucket: string,
    key: string,
    body: Buffer,
    size: number,
    metadata: Readonly<Record<string, string>>,
  ): Promise<unknown>;
  removeObject(bucket: string, key: string): Promise<void>;
}

export interface MinioObjectStorageOptions {
  readonly client: MinioClientLike;
  readonly publicEndpoint?: string;
}

type MinioTransport = NonNullable<ClientOptions['transport']>;
type NativeRequest = (
  options: RequestOptions,
  callback?: (response: IncomingMessage) => void,
) => ClientRequest;

function withPathPrefix(url: string, publicEndpoint: string | undefined): string {
  if (publicEndpoint === undefined || publicEndpoint === '') return url;

  const source = new URL(url);
  const endpoint = new URL(publicEndpoint);
  const prefix = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/+$/, '');
  source.protocol = endpoint.protocol;
  source.hostname = endpoint.hostname;
  source.port = endpoint.port;
  source.pathname = `${prefix}${source.pathname}`;
  return source.toString();
}

function contentType(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const value = metadata?.['content-type'] ?? metadata?.['Content-Type'];
  return typeof value === 'string' ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isObjectNotFound(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'NotFound' || code === 'NoSuchKey' || code === 'BlobNotFound';
}

export class MinioObjectStorage implements ObjectStorage {
  private readonly ensuredContainers = new Set<string>();

  constructor(private readonly options: MinioObjectStorageOptions) {}

  async ensureContainer(container: string): Promise<void> {
    if (this.ensuredContainers.has(container)) return;
    if (!(await this.options.client.bucketExists(container))) {
      await this.options.client.makeBucket(container);
    }
    this.ensuredContainers.add(container);
  }

  async presignGet(container: string, key: string, expirySeconds: number): Promise<string> {
    const url = await this.options.client.presignedGetObject(container, key, expirySeconds);
    return withPathPrefix(url, this.options.publicEndpoint);
  }

  async presignPut(container: string, key: string, expirySeconds: number): Promise<string> {
    const url = await this.options.client.presignedPutObject(container, key, expirySeconds);
    return withPathPrefix(url, this.options.publicEndpoint);
  }

  async statObject(container: string, key: string): Promise<ObjectMetadata> {
    const stat = await this.options.client.statObject(container, key);
    return {
      etag: stat.etag,
      mimeType: contentType(stat.metaData),
      sizeBytes: stat.size,
    };
  }

  getObject(container: string, key: string): Promise<NodeJS.ReadableStream> {
    return this.options.client.getObject(container, key);
  }

  async putObject(
    container: string,
    key: string,
    body: Buffer,
    contentTypeValue: string,
  ): Promise<PutObjectResult> {
    await this.ensureContainer(container);
    const result = await this.options.client.putObject(container, key, body, body.length, {
      'Content-Type': contentTypeValue,
    });
    const etag =
      typeof result === 'object' && result !== null && 'etag' in result
        ? (result as { readonly etag?: unknown }).etag
        : undefined;
    return { etag: typeof etag === 'string' ? etag : undefined, reconciled: false };
  }

  async objectExists(container: string, key: string): Promise<boolean> {
    try {
      await this.options.client.statObject(container, key);
      return true;
    } catch (error) {
      if (isObjectNotFound(error)) return false;
      throw error;
    }
  }

  deleteObject(container: string, key: string): Promise<void> {
    return this.options.client.removeObject(container, key);
  }
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function createTimedTransport(useSSL: boolean, timeoutMs: number): MinioTransport {
  const nativeRequest = (useSSL ? https.request : http.request) as NativeRequest;
  const request = ((options: RequestOptions, callback?: (response: IncomingMessage) => void) =>
    nativeRequest(
      { ...options, signal: AbortSignal.timeout(timeoutMs) },
      callback,
    )) as MinioTransport['request'];
  return { request };
}

export function createMinioClient(env: StorageEnvironment): MinioClientLike {
  const useSSL = env.MINIO_USE_SSL === 'true';
  const requestTimeoutMs = optionalPositiveInteger(
    env.MINIO_REQUEST_TIMEOUT_MS,
    'MINIO_REQUEST_TIMEOUT_MS',
  );
  return new MinioClient({
    accessKey: env.MINIO_ROOT_USER ?? 'careos',
    endPoint: env.MINIO_ENDPOINT ?? 'minio',
    pathStyle: true,
    port: Number(env.MINIO_PORT ?? 9000),
    region: env.MINIO_REGION ?? 'us-east-1',
    secretKey: env.MINIO_ROOT_PASSWORD ?? 'change-me',
    ...(requestTimeoutMs === undefined
      ? {}
      : { transport: createTimedTransport(useSSL, requestTimeoutMs) }),
    useSSL,
  });
}
