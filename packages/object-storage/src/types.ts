export interface ObjectMetadata {
  readonly etag: string | undefined;
  readonly mimeType: string | undefined;
  readonly sizeBytes: number;
}

export interface PutObjectResult {
  readonly etag: string | undefined;
  readonly reconciled: boolean;
}

export interface ObjectStorage {
  ensureContainer(container: string): Promise<void>;
  presignGet(container: string, key: string, expirySeconds: number): Promise<string>;
  presignPut(container: string, key: string, expirySeconds: number): Promise<string>;
  statObject(container: string, key: string): Promise<ObjectMetadata>;
  getObject(container: string, key: string): Promise<NodeJS.ReadableStream>;
  putObject(
    container: string,
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<PutObjectResult>;
  objectExists(container: string, key: string): Promise<boolean>;
  deleteObject(container: string, key: string): Promise<void>;
}

export type StorageEnvironment = Readonly<Record<string, string | undefined>>;
