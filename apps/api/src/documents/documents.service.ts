import { randomUUID } from 'node:crypto';

import type { IncidentActor } from '@careos/contracts';
import { documentIngestWorkflowId } from '@careos/contracts';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  type DocumentWorkflowRuntime,
  WORKFLOW_RUNTIME,
} from '../workflow-runtime/workflow-runtime.port.js';

import type {
  DocumentListResponse,
  DocumentResponse,
  PresignDocumentDto,
  PresignDocumentResponse,
  RegisterDocumentDto,
  RegisterDocumentResponse,
} from './dto.js';

interface RequestContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly uploaderUserId: string;
  readonly correlationId: string;
  readonly actor: IncidentActor;
}

interface DocumentRow {
  readonly id: string;
  readonly objectKey: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly status: 'uploaded' | 'extracting' | 'extracted' | 'failed';
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(WORKFLOW_RUNTIME)
    private readonly workflowRuntime: DocumentWorkflowRuntime,
    @Inject(StorageService)
    private readonly storage: StorageService,
  ) {}

  async presign(
    dto: PresignDocumentDto,
    context: RequestContext,
  ): Promise<PresignDocumentResponse> {
    const documentId = randomUUID();
    const filename = sanitizeFilename(dto.original_filename);
    const objectKey =
      `tenants/${context.tenantId}/homes/${context.homeId}/documents/` +
      `${documentId}/${filename}`;
    return {
      objectKey,
      uploadUrl: await this.storage.presignedDocumentUpload(objectKey, 300),
    };
  }

  async register(
    dto: RegisterDocumentDto,
    context: RequestContext,
  ): Promise<RegisterDocumentResponse> {
    const expectedPrefix = `tenants/${context.tenantId}/homes/${context.homeId}/documents/`;
    if (!dto.object_key.startsWith(expectedPrefix)) {
      throw new BadRequestException('Document object key is outside the active tenant and home.');
    }
    const id = documentIdFromObjectKey(dto.object_key, expectedPrefix, dto.original_filename);
    const metadata = await this.storage.statDocument(dto.object_key);
    if (metadata.mimeType !== dto.mime_type || metadata.sizeBytes !== dto.size_bytes) {
      throw new BadRequestException('Uploaded document metadata does not match registration.');
    }

    const workflowId = documentIngestWorkflowId(id);

    await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) => transaction.$executeRaw`
        INSERT INTO core.documents
          (id, tenant_id, home_id, uploader_user_id, workflow_id,
           object_key, original_filename, mime_type, size_bytes, status,
           created_at, updated_at)
        VALUES (
          ${id}::uuid, ${context.tenantId}::uuid, ${context.homeId}::uuid,
          ${context.uploaderUserId}::uuid, ${workflowId},
          ${dto.object_key}, ${dto.original_filename}, ${dto.mime_type},
          ${dto.size_bytes}, 'uploaded'::"core"."DocumentStatus",
          now(), now()
        )
        ON CONFLICT (id) DO NOTHING
      `,
    );

    const started = await this.workflowRuntime.startDocIngestWorkflow({
      actor: context.actor,
      documentId: id,
      homeId: context.homeId,
      tenantId: context.tenantId,
    });

    return { id, status: 'processing', workflowId: started.workflowId ?? workflowId };
  }

  async list(context: RequestContext): Promise<DocumentListResponse> {
    const rows = await this.queryDocuments(context);
    return { documents: rows.map(toDocumentResponse) };
  }

  async findById(id: string, context: RequestContext): Promise<DocumentResponse> {
    const rows = await this.queryDocuments(context, id);
    const row = rows[0];
    if (row === undefined) throw new NotFoundException(`Document ${id} not found.`);
    return toDocumentResponse(row);
  }

  private queryDocuments(context: RequestContext, id?: string): Promise<DocumentRow[]> {
    return this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) => transaction.$queryRaw<DocumentRow[]>`
        SELECT
          id::text AS "id",
          object_key AS "objectKey",
          original_filename AS "originalFilename",
          mime_type AS "mimeType",
          size_bytes AS "sizeBytes",
          status::text AS "status",
          failure_reason AS "failureReason",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM core.documents
        WHERE (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
        ORDER BY created_at DESC
        LIMIT ${id === undefined ? 50 : 1}
      `,
    );
  }
}

function toDocumentResponse(row: DocumentRow): DocumentResponse {
  return {
    createdAt: row.createdAt.toISOString(),
    failureReason: row.failureReason,
    id: row.id,
    mimeType: row.mimeType,
    objectKey: row.objectKey,
    originalFilename: row.originalFilename,
    sizeBytes: row.sizeBytes,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sanitizeFilename(value: string): string {
  const basename = value.replace(/\\/g, '/').split('/').pop() ?? 'document';
  const sanitized = basename
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
  return sanitized === '' ? 'document' : sanitized;
}

function documentIdFromObjectKey(
  objectKey: string,
  expectedPrefix: string,
  originalFilename: string,
): string {
  const parts = objectKey.slice(expectedPrefix.length).split('/');
  const [documentId, filename] = parts;
  if (
    parts.length !== 2 ||
    documentId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      documentId,
    ) ||
    filename !== sanitizeFilename(originalFilename)
  ) {
    throw new BadRequestException('Document object key does not match the presigned upload.');
  }
  return documentId;
}
