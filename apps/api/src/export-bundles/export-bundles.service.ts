import { randomUUID } from 'node:crypto';

import type { IncidentActor } from '@careos/contracts';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  type ExportBundleWorkflowRuntime,
  WORKFLOW_RUNTIME,
} from '../workflow-runtime/workflow-runtime.port.js';

import type {
  ExportBundleDownloadResponse,
  ExportBundleResponse,
  RequestExportBundleDto,
  RequestExportBundleResponse,
} from './dto.js';

interface RequestContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly requestedByUserId: string;
  readonly correlationId: string;
  readonly actor: IncidentActor;
}

interface BundleRow {
  readonly id: string;
  readonly incidentId: string;
  readonly status: 'pending' | 'building' | 'ready' | 'failed';
  readonly objectKey: string | null;
  readonly manifestSha256: string | null;
  readonly signature: string | null;
  readonly signatureAlgorithm: string | null;
  readonly sizeBytes: number | null;
  readonly retainUntil: Date | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

@Injectable()
export class ExportBundlesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(WORKFLOW_RUNTIME) private readonly workflowRuntime: ExportBundleWorkflowRuntime,
  ) {}

  async request(
    dto: RequestExportBundleDto,
    context: RequestContext,
  ): Promise<RequestExportBundleResponse> {
    const id = randomUUID();
    const workflowId = `serious-incident-export-${id}`;

    await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      async (transaction) => {
        // Ensure incident exists within tenant/home — RLS guarantees no cross-home leak.
        const incident = await transaction.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id::text AS "id", status::text AS "status" FROM core.incidents
         WHERE id = ${dto.incident_id}::uuid
           AND soft_deleted_at IS NULL
         LIMIT 1
      `;
        if (incident[0] === undefined) {
          throw new NotFoundException(`Incident ${dto.incident_id} not found.`);
        }
        if (!['approved', 'exported'].includes(incident[0].status)) {
          throw new ConflictException('Only approved incidents can be bundled.');
        }
        await transaction.$executeRaw`
        INSERT INTO core.export_bundles
          (id, tenant_id, home_id, incident_id, requested_by_user_id,
           workflow_id, status, created_at, updated_at)
        VALUES (
          ${id}::uuid, ${context.tenantId}::uuid, ${context.homeId}::uuid,
          ${dto.incident_id}::uuid, ${context.requestedByUserId}::uuid,
          ${workflowId}, 'pending'::"core"."ExportBundleStatus",
          now(), now()
        )
      `;
      },
    );

    const started = await this.workflowRuntime.startSeriousIncidentExportWorkflow({
      actor: context.actor,
      bundleId: id,
      homeId: context.homeId,
      incidentId: dto.incident_id,
      tenantId: context.tenantId,
    });

    return { id, status: 'pending', workflowId: started.workflowId };
  }

  async findById(id: string, context: RequestContext): Promise<ExportBundleResponse> {
    const rows = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) => transaction.$queryRaw<BundleRow[]>`
        SELECT
          id::text AS "id",
          incident_id::text AS "incidentId",
          status::text AS "status",
          object_key AS "objectKey",
          manifest_sha256 AS "manifestSha256",
          signature AS "signature",
          signature_algorithm AS "signatureAlgorithm",
          size_bytes AS "sizeBytes",
          retain_until AS "retainUntil",
          failure_reason AS "failureReason",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
          FROM core.export_bundles
         WHERE id = ${id}::uuid
         LIMIT 1
      `,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`Export bundle ${id} not found.`);
    }
    return {
      createdAt: row.createdAt.toISOString(),
      failureReason: row.failureReason,
      id: row.id,
      incidentId: row.incidentId,
      manifestSha256: row.manifestSha256,
      objectKey: row.objectKey,
      retainUntil: row.retainUntil ? row.retainUntil.toISOString() : null,
      signature: row.signature,
      signatureAlgorithm: row.signatureAlgorithm,
      sizeBytes: row.sizeBytes,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async presignDownload(
    id: string,
    context: RequestContext,
    expirySeconds = 300,
  ): Promise<ExportBundleDownloadResponse> {
    const rows = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) => transaction.$queryRaw<Array<{ status: string; objectKey: string | null }>>`
        SELECT status::text AS "status", object_key AS "objectKey"
          FROM core.export_bundles
         WHERE id = ${id}::uuid
         LIMIT 1
      `,
    );
    const row = rows[0];
    if (row === undefined || row.status !== 'ready' || row.objectKey === null) {
      throw new NotFoundException(`Export bundle ${id} is not ready for download.`);
    }

    const url = await this.storage.presignedExportBundleDownload(row.objectKey, expirySeconds);
    const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

    // Append-only audit row for the download event. The status-change trigger
    // doesn't fire because we're not flipping status; we INSERT directly.
    await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) => transaction.$executeRaw`
        INSERT INTO audit.events
          (tenant_id, home_id, actor_kind, actor_user_id, correlation_id,
           action, subject_type, subject_id, metadata)
        VALUES (
          ${context.tenantId}::uuid, ${context.homeId}::uuid,
          ${context.actor.kind},
          ${context.actor.userId ?? null}::uuid,
          ${context.correlationId},
          'export_bundle.downloaded',
          'export_bundle',
          ${id}::uuid,
          ${JSON.stringify({ expires_at: expiresAt, object_key: row.objectKey })}::jsonb
        )
      `,
    );

    return { expiresAt, url };
  }
}
