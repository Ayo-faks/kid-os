import { createHash, randomUUID } from 'node:crypto';

import {
  DOCUMENT_INGEST_DURABLE_VERSION,
  DOCUMENT_INGEST_DURABLE_WORKFLOW_TYPE,
  EMAIL_DRAFT_DURABLE_VERSION,
  EMAIL_DRAFT_DURABLE_WORKFLOW_TYPE,
  HANDOVER_DURABLE_VERSION,
  HANDOVER_DURABLE_WORKFLOW_TYPE,
  INCIDENT_DURABLE_VERSION,
  INCIDENT_DURABLE_WORKFLOW_TYPE,
  PING_DURABLE_VERSION,
  PING_DURABLE_WORKFLOW_TYPE,
  RETENTION_DURABLE_VERSION,
  RETENTION_SWEEP_DURABLE_WORKFLOW_TYPE,
  ROTA_ANALYZE_DURABLE_VERSION,
  ROTA_ANALYZE_DURABLE_WORKFLOW_TYPE,
  ROTA_PUBLISH_DURABLE_VERSION,
  ROTA_PUBLISH_DURABLE_WORKFLOW_TYPE,
  SERIOUS_INCIDENT_EXPORT_DURABLE_VERSION,
  SERIOUS_INCIDENT_EXPORT_DURABLE_WORKFLOW_TYPE,
  documentIngestWorkflowId,
  emailDraftWorkflowId,
  handoverWorkflowId,
  incidentWorkflowId,
  pingWorkflowId,
  retentionSweepWorkflowId,
  rotaAnalyzeWorkflowId,
  rotaPublishWorkflowId,
  seriousIncidentExportWorkflowId,
  type ApprovalDecisionSignal,
  type DocIngestWorkflowInput,
  type ExportSignal,
  type RotaAnalysisResult,
  type RotaAnalyzeWorkflowInput,
  type SubmitForApprovalSignal,
  type UpdateDraftSignal,
} from '@careos/contracts';
import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service.js';
import { TemporalService } from '../temporal/temporal.service.js';

import {
  DurableApprovalEventClient,
  type ApprovalDurableEventClient,
} from './durable-approval-event.client.js';
import { DurableDocumentClient, type DocumentDurableClient } from './durable-document.client.js';
import {
  DurableEmailDraftClient,
  type EmailDraftDurableClient,
} from './durable-email-draft.client.js';
import {
  DurableExportBundleClient,
  type ExportBundleDurableClient,
} from './durable-export-bundle.client.js';
import { DurableHandoverClient, type HandoverDurableClient } from './durable-handover.client.js';
import { DurableIncidentClient, type IncidentDurableClient } from './durable-incident.client.js';
import { DurablePingClient, type PingDurableClient } from './durable-ping.client.js';
import { DurableRetentionClient, type RetentionDurableClient } from './durable-retention.client.js';
import {
  DurableRotaAnalyzeClient,
  type RotaAnalyzeDurableClient,
} from './durable-rota-analyze.client.js';
import {
  DurableRotaPublishClient,
  type RotaPublishDurableClient,
} from './durable-rota-publish.client.js';
import { TemporalWorkflowRuntimeAdapter } from './temporal-workflow-runtime.adapter.js';
import type {
  ApprovalRuntimeRoutingContext,
  IncidentRuntimeRoutingContext,
  StartedDocIngestWorkflow,
  StartedEmailDraftWorkflow,
  StartedExportBundleWorkflow,
  StartedHandoverWorkflow,
  StartedIncidentWorkflow,
  StartedPingWorkflow,
  StartedRetentionSweepWorkflow,
  StartedRotaPublishWorkflow,
  StartIncidentReportWorkflowInput,
  StartRetentionSweepWorkflowInput,
  StartHandoverWorkflowInput,
  StartEmailDraftWorkflowInput,
  StartSeriousIncidentExportWorkflowInput,
  StartRotaPublishWorkflowInput,
} from './workflow-runtime.port.js';

interface ApprovalWorkflowOwnerRow {
  readonly id: string;
  readonly instanceId: string;
  readonly runtime: 'temporal' | 'durable';
}

interface WorkflowCommandIdRow {
  readonly id: string;
}

@Injectable()
export class WorkflowRuntimeRouter extends TemporalWorkflowRuntimeAdapter {
  constructor(
    @Inject(TemporalService) temporal: TemporalService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DurableApprovalEventClient)
    private readonly durableApprovals: ApprovalDurableEventClient,
    @Inject(DurableDocumentClient)
    private readonly durableDocuments: DocumentDurableClient,
    @Inject(DurableEmailDraftClient)
    private readonly durableEmailDrafts: EmailDraftDurableClient,
    @Inject(DurableExportBundleClient)
    private readonly durableExportBundles: ExportBundleDurableClient,
    @Inject(DurableHandoverClient)
    private readonly durableHandovers: HandoverDurableClient,
    @Inject(DurableIncidentClient)
    private readonly durableIncidents: IncidentDurableClient,
    @Inject(DurablePingClient)
    private readonly durablePing: PingDurableClient,
    @Inject(DurableRetentionClient)
    private readonly durableRetention: RetentionDurableClient,
    @Inject(DurableRotaAnalyzeClient)
    private readonly durableRotaAnalyze: RotaAnalyzeDurableClient,
    @Inject(DurableRotaPublishClient)
    private readonly durableRotaPublish: RotaPublishDurableClient,
  ) {
    super(temporal);
  }

  override async startPingWorkflow(message = 'hello from NestJS'): Promise<StartedPingWorkflow> {
    if (!durableRuntimeEnabled(process.env.WORKFLOW_RUNTIME_PING, 'WORKFLOW_RUNTIME_PING')) {
      return super.startPingWorkflow(message);
    }
    if (message.length === 0 || message.length > 2_000) {
      throw new ConflictException('Ping message length must be between 1 and 2000 characters.');
    }

    const pingId = randomUUID();
    const instanceId = pingWorkflowId(pingId);
    const correlationId = `ping:${pingId}`;
    const registration = await this.prisma.withSystemContext(
      { correlationId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          INSERT INTO core.system_workflow_instances (
            id, workflow_kind, runtime, instance_id, orchestration_name,
            orchestration_version, status, correlation_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), 'ping', 'durable'::"core"."WorkflowRuntimeKind",
            ${instanceId}, ${PING_DURABLE_WORKFLOW_TYPE}, ${PING_DURABLE_VERSION},
            'running', ${correlationId}, now(), now()
          )
          ON CONFLICT (instance_id)
          DO UPDATE SET instance_id = core.system_workflow_instances.instance_id
          RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
        `;
        const owner = owners[0];
        if (owner === undefined) throw new Error(`Ping workflow ${pingId} was not registered.`);
        if (owner.runtime !== 'durable' || owner.instanceId !== instanceId) {
          throw new ConflictException(
            `Ping ${pingId} is already owned by ${owner.runtime}:${owner.instanceId}.`,
          );
        }

        const serializedPayload = JSON.stringify({ message });
        const payloadHash = createHash('sha256').update(serializedPayload).digest('hex');
        const commandId = randomUUID();
        const commands = await transaction.$queryRaw<WorkflowCommandIdRow[]>`
          INSERT INTO core.system_workflow_commands (
            id, workflow_instance_id, command_type, payload, payload_hash,
            status, created_at, updated_at
          ) VALUES (
            ${commandId}::uuid, ${owner.id}::uuid, 'ping.initialize',
            ${serializedPayload}::jsonb, ${payloadHash},
            'pending'::"core"."WorkflowCommandStatus", now(), now()
          )
          ON CONFLICT (workflow_instance_id, command_type, payload_hash)
          DO UPDATE SET payload_hash = EXCLUDED.payload_hash
          RETURNING id::text AS "id"
        `;
        const persistedCommandId = commands[0]?.id;
        if (persistedCommandId === undefined) {
          throw new Error(`Ping command for ${pingId} was not persisted.`);
        }
        return { commandId: persistedCommandId, owner };
      },
    );

    await this.durablePing.start(registration.owner.instanceId, {
      commandId: registration.commandId,
      correlationId,
      pingId,
    });
    return {
      runId: registration.owner.instanceId,
      taskQueue: 'careos.durable',
      workflowId: registration.owner.instanceId,
    };
  }

  override async startRetentionSweepWorkflow(
    input: StartRetentionSweepWorkflowInput,
  ): Promise<StartedRetentionSweepWorkflow> {
    if (
      !durableRuntimeEnabled(process.env.WORKFLOW_RUNTIME_RETENTION, 'WORKFLOW_RUNTIME_RETENTION')
    ) {
      return super.startRetentionSweepWorkflow(input);
    }

    const sweepId = randomUUID();
    const instanceId = retentionSweepWorkflowId(sweepId);
    const owner = await this.prisma.withTenantContext(
      { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          INSERT INTO core.workflow_instances (
            id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
            runtime, instance_id, orchestration_name, orchestration_version,
            status, correlation_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${input.tenantId}::uuid, ${input.homeId}::uuid,
            'retention-sweep', 'retention_sweep', ${sweepId}::uuid,
            'durable'::"core"."WorkflowRuntimeKind", ${instanceId},
            ${RETENTION_SWEEP_DURABLE_WORKFLOW_TYPE}, ${RETENTION_DURABLE_VERSION},
            'running', ${input.correlationId ?? input.actor.correlationId}, now(), now()
          )
          ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
          DO UPDATE SET instance_id = core.workflow_instances.instance_id
          RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
        `;
        const registered = owners[0];
        if (registered === undefined) {
          throw new Error(`Retention sweep ${sweepId} was not registered.`);
        }
        if (registered.runtime !== 'durable' || registered.instanceId !== instanceId) {
          throw new ConflictException(
            `Retention sweep ${sweepId} is already owned by ${registered.runtime}:${registered.instanceId}.`,
          );
        }
        return registered;
      },
    );

    await this.durableRetention.start(owner.instanceId, {
      correlationId: input.correlationId ?? input.actor.correlationId,
      nowIso: input.nowIso,
      owner: {
        homeId: input.homeId,
        tenantId: input.tenantId,
        workflowInstanceId: owner.id,
      },
      sweepId,
    });
    return {
      runId: owner.instanceId,
      taskQueue: 'careos.durable',
      workflowId: owner.instanceId,
    };
  }

  override async executeRotaAnalyzeWorkflow(
    input: RotaAnalyzeWorkflowInput,
  ): Promise<RotaAnalysisResult> {
    if (
      !durableRuntimeEnabled(
        process.env.WORKFLOW_RUNTIME_ROTA_ANALYZE,
        'WORKFLOW_RUNTIME_ROTA_ANALYZE',
      )
    ) {
      return super.executeRotaAnalyzeWorkflow(input);
    }

    const analysisId = randomUUID();
    const instanceId = rotaAnalyzeWorkflowId(analysisId);
    const registration = await this.prisma.withTenantContext(
      { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          INSERT INTO core.workflow_instances (
            id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
            runtime, instance_id, orchestration_name, orchestration_version,
            status, correlation_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${input.tenantId}::uuid, ${input.homeId}::uuid,
            'rota-analyze', 'rota_analysis', ${analysisId}::uuid,
            'durable'::"core"."WorkflowRuntimeKind", ${instanceId},
            ${ROTA_ANALYZE_DURABLE_WORKFLOW_TYPE}, ${ROTA_ANALYZE_DURABLE_VERSION},
            'running', ${input.correlationId}, now(), now()
          )
          ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
          DO UPDATE SET instance_id = core.workflow_instances.instance_id
          RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
        `;
        const owner = owners[0];
        if (owner === undefined) {
          throw new Error(`Rota Analyze workflow ${analysisId} was not registered.`);
        }
        if (owner.runtime !== 'durable' || owner.instanceId !== instanceId) {
          throw new ConflictException(
            `Rota analysis ${analysisId} is already owned by ${owner.runtime}:${owner.instanceId}.`,
          );
        }
        await transaction.$queryRaw`
          INSERT INTO core.rota_analysis_results (
            id, tenant_id, home_id, workflow_id, correlation_id, status,
            result, failure_code, created_at, updated_at
          ) VALUES (
            ${analysisId}::uuid, ${input.tenantId}::uuid, ${input.homeId}::uuid,
            ${instanceId}, ${input.correlationId}, 'processing', NULL, NULL, now(), now()
          )
          ON CONFLICT (id) DO NOTHING
        `;
        const commandId = await persistCommand(
          transaction,
          owner.id,
          input.tenantId,
          input.homeId,
          'rota-analyze.initialize',
          input,
        );
        return { commandId, owner };
      },
    );

    await this.durableRotaAnalyze.execute(registration.owner.instanceId, {
      actor: input.actor,
      analysisId,
      commandId: registration.commandId,
      homeId: input.homeId,
      requestedByUserId: input.requestedByUserId,
      tenantId: input.tenantId,
    });

    const rows = await this.prisma.withTenantContext(
      { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
      (transaction) => transaction.$queryRaw<
        Array<{
          readonly failureCode: string | null;
          readonly result: unknown;
          readonly status: string;
        }>
      >`
        SELECT status, result, failure_code AS "failureCode"
          FROM core.rota_analysis_results
         WHERE id = ${analysisId}::uuid
         LIMIT 1
      `,
    );
    const row = rows[0];
    if (row?.status !== 'completed' || row.result === null) {
      throw new ServiceUnavailableException(
        `Rota analysis did not produce a completed result (${row?.failureCode ?? 'missing-result'}).`,
      );
    }
    return parsePersistedRotaAnalysis(row.result, input);
  }

  override async startRotaPublishWorkflow(
    input: StartRotaPublishWorkflowInput,
  ): Promise<StartedRotaPublishWorkflow> {
    if (
      !durableRuntimeEnabled(
        process.env.WORKFLOW_RUNTIME_ROTA_PUBLISH,
        'WORKFLOW_RUNTIME_ROTA_PUBLISH',
      )
    ) {
      return super.startRotaPublishWorkflow(input);
    }

    const publicationId = input.publicationId ?? randomUUID();
    const instanceId = rotaPublishWorkflowId(publicationId);
    const registration = await this.prisma.withTenantContext(
      { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          INSERT INTO core.workflow_instances (
            id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
            runtime, instance_id, orchestration_name, orchestration_version,
            status, correlation_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${input.tenantId}::uuid, ${input.homeId}::uuid,
            'rota-publish', 'rota_publication', ${publicationId}::uuid,
            'durable'::"core"."WorkflowRuntimeKind", ${instanceId},
            ${ROTA_PUBLISH_DURABLE_WORKFLOW_TYPE}, ${ROTA_PUBLISH_DURABLE_VERSION},
            'running', ${input.correlationId}, now(), now()
          )
          ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
          DO UPDATE SET instance_id = core.workflow_instances.instance_id
          RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
        `;
        const owner = owners[0];
        if (owner === undefined) {
          throw new Error(`Rota Publish workflow ${publicationId} was not registered.`);
        }
        if (owner.runtime !== 'durable' || owner.instanceId !== instanceId) {
          throw new ConflictException(
            `Rota publication ${publicationId} is already owned by ${owner.runtime}:${owner.instanceId}.`,
          );
        }
        const commandId = await persistCommand(
          transaction,
          owner.id,
          input.tenantId,
          input.homeId,
          'rota-publish.initialize',
          { ...input, publicationId },
        );
        return { commandId, owner };
      },
    );

    await this.durableRotaPublish.start(registration.owner.instanceId, {
      actor: input.actor,
      commandId: registration.commandId,
      homeId: input.homeId,
      publicationId,
      publishedByUserId: input.publishedByUserId,
      shiftIds: input.shiftIds,
      tenantId: input.tenantId,
    });
    return {
      publicationId,
      runId: registration.owner.instanceId,
      taskQueue: 'careos.durable',
      workflowId: registration.owner.instanceId,
    };
  }

  override async startEmailDraftWorkflow(
    input: StartEmailDraftWorkflowInput,
  ): Promise<StartedEmailDraftWorkflow> {
    if (
      !durableRuntimeEnabled(
        process.env.WORKFLOW_RUNTIME_EMAIL_DRAFTS,
        'WORKFLOW_RUNTIME_EMAIL_DRAFTS',
      )
    ) {
      return super.startEmailDraftWorkflow(input);
    }
    if (
      !durableRuntimeEnabled(process.env.WORKFLOW_RUNTIME_APPROVALS, 'WORKFLOW_RUNTIME_APPROVALS')
    ) {
      throw new ConflictException(
        'WORKFLOW_RUNTIME_APPROVALS must be "durable" when email drafts use Durable Task.',
      );
    }

    const emailDraftId = input.emailDraftId ?? randomUUID();
    const instanceId = emailDraftWorkflowId(emailDraftId);
    const actor = input.actor ?? {
      correlationId: input.correlationId,
      kind: 'user' as const,
      userId: input.authorUserId,
    };
    const registration = await this.prisma.withTenantContext(
      { actor, homeId: input.homeId, tenantId: input.tenantId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          INSERT INTO core.workflow_instances (
            id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
            runtime, instance_id, orchestration_name, orchestration_version,
            status, correlation_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${input.tenantId}::uuid, ${input.homeId}::uuid,
            'email-draft', 'email_draft', ${emailDraftId}::uuid,
            'durable'::"core"."WorkflowRuntimeKind", ${instanceId},
            ${EMAIL_DRAFT_DURABLE_WORKFLOW_TYPE}, ${EMAIL_DRAFT_DURABLE_VERSION},
            'running', ${input.correlationId}, now(), now()
          )
          ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
          DO UPDATE SET instance_id = core.workflow_instances.instance_id
          RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
        `;
        const owner = owners[0];
        if (owner === undefined) {
          throw new Error(`Email draft workflow ${emailDraftId} was not registered.`);
        }
        if (owner.runtime !== 'durable' || owner.instanceId !== instanceId) {
          throw new ConflictException(
            `Email draft ${emailDraftId} is already owned by ${owner.runtime}:${owner.instanceId}.`,
          );
        }
        const commandId = await persistCommand(
          transaction,
          owner.id,
          input.tenantId,
          input.homeId,
          'email-draft.initialize',
          { ...input, emailDraftId },
        );
        return { commandId, owner };
      },
    );

    await this.durableEmailDrafts.start(registration.owner.instanceId, {
      actor,
      authorUserId: input.authorUserId,
      commandId: registration.commandId,
      emailDraftId,
      homeId: input.homeId,
      tenantId: input.tenantId,
    });
    return {
      emailDraftId,
      runId: registration.owner.instanceId,
      taskQueue: 'careos.durable',
      workflowId: registration.owner.instanceId,
    };
  }

  override async startHandoverWorkflow(
    input: StartHandoverWorkflowInput,
  ): Promise<StartedHandoverWorkflow> {
    if (
      !durableRuntimeEnabled(process.env.WORKFLOW_RUNTIME_HANDOVERS, 'WORKFLOW_RUNTIME_HANDOVERS')
    ) {
      return super.startHandoverWorkflow(input);
    }

    const handoverId = input.handoverId ?? randomUUID();
    const instanceId = handoverWorkflowId(handoverId);
    const actor = {
      correlationId: input.correlationId,
      kind: 'user' as const,
      userId: input.authorUserId,
    };
    const registration = await this.prisma.withTenantContext(
      { actor, homeId: input.homeId, tenantId: input.tenantId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          INSERT INTO core.workflow_instances (
            id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
            runtime, instance_id, orchestration_name, orchestration_version,
            status, correlation_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${input.tenantId}::uuid, ${input.homeId}::uuid,
            'handover', 'handover', ${handoverId}::uuid,
            'durable'::"core"."WorkflowRuntimeKind", ${instanceId},
            ${HANDOVER_DURABLE_WORKFLOW_TYPE}, ${HANDOVER_DURABLE_VERSION},
            'running', ${input.correlationId}, now(), now()
          )
          ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
          DO UPDATE SET instance_id = core.workflow_instances.instance_id
          RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
        `;
        const owner = owners[0];
        if (owner === undefined) {
          throw new Error(`Handover workflow ${handoverId} was not registered.`);
        }
        if (owner.runtime !== 'durable' || owner.instanceId !== instanceId) {
          throw new ConflictException(
            `Handover ${handoverId} is already owned by ${owner.runtime}:${owner.instanceId}.`,
          );
        }
        const commandId = await persistCommand(
          transaction,
          owner.id,
          input.tenantId,
          input.homeId,
          'handover.initialize',
          { ...input, handoverId },
        );
        return { commandId, owner };
      },
    );

    await this.durableHandovers.start(registration.owner.instanceId, {
      actor,
      authorUserId: input.authorUserId,
      commandId: registration.commandId,
      handoverId,
      homeId: input.homeId,
      shiftId: input.shiftId,
      tenantId: input.tenantId,
    });
    return {
      handoverId,
      runId: registration.owner.instanceId,
      taskQueue: 'careos.durable',
      workflowId: registration.owner.instanceId,
    };
  }

  override async startSeriousIncidentExportWorkflow(
    input: StartSeriousIncidentExportWorkflowInput,
  ): Promise<StartedExportBundleWorkflow> {
    if (
      !durableRuntimeEnabled(
        process.env.WORKFLOW_RUNTIME_EXPORT_BUNDLES,
        'WORKFLOW_RUNTIME_EXPORT_BUNDLES',
      )
    ) {
      return super.startSeriousIncidentExportWorkflow(input);
    }

    const instanceId = seriousIncidentExportWorkflowId(input.bundleId);
    const registration = await this.prisma.withTenantContext(
      { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          INSERT INTO core.workflow_instances (
            id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
            runtime, instance_id, orchestration_name, orchestration_version,
            status, correlation_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${input.tenantId}::uuid, ${input.homeId}::uuid,
            'export-bundle', 'export_bundle', ${input.bundleId}::uuid,
            'durable'::"core"."WorkflowRuntimeKind", ${instanceId},
            ${SERIOUS_INCIDENT_EXPORT_DURABLE_WORKFLOW_TYPE},
            ${SERIOUS_INCIDENT_EXPORT_DURABLE_VERSION},
            'running', ${input.actor.correlationId}, now(), now()
          )
          ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
          DO UPDATE SET instance_id = core.workflow_instances.instance_id
          RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
        `;
        const owner = owners[0];
        if (owner === undefined) {
          throw new Error(`Export bundle workflow ${input.bundleId} was not registered.`);
        }
        if (owner.runtime !== 'durable' || owner.instanceId !== instanceId) {
          throw new ConflictException(
            `Export bundle ${input.bundleId} is already owned by ${owner.runtime}:${owner.instanceId}.`,
          );
        }
        return owner;
      },
    );

    await this.durableExportBundles.start(registration.instanceId, input);
    return {
      bundleId: input.bundleId,
      runId: registration.instanceId,
      taskQueue: 'careos.durable',
      workflowId: registration.instanceId,
    };
  }

  override async startDocIngestWorkflow(
    input: DocIngestWorkflowInput,
  ): Promise<StartedDocIngestWorkflow> {
    if (
      !durableRuntimeEnabled(process.env.WORKFLOW_RUNTIME_DOCUMENTS, 'WORKFLOW_RUNTIME_DOCUMENTS')
    ) {
      return super.startDocIngestWorkflow(input);
    }

    const instanceId = documentIngestWorkflowId(input.documentId);
    const registration = await this.prisma.withTenantContext(
      { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          INSERT INTO core.workflow_instances (
            id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
            runtime, instance_id, orchestration_name, orchestration_version,
            status, correlation_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${input.tenantId}::uuid, ${input.homeId}::uuid,
            'document', 'document', ${input.documentId}::uuid,
            'durable'::"core"."WorkflowRuntimeKind", ${instanceId},
            ${DOCUMENT_INGEST_DURABLE_WORKFLOW_TYPE}, ${DOCUMENT_INGEST_DURABLE_VERSION},
            'running', ${input.actor.correlationId}, now(), now()
          )
          ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
          DO UPDATE SET instance_id = core.workflow_instances.instance_id
          RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
        `;
        const owner = owners[0];
        if (owner === undefined) {
          throw new Error(`Document workflow ${input.documentId} was not registered.`);
        }
        if (owner.runtime !== 'durable' || owner.instanceId !== instanceId) {
          throw new ConflictException(
            `Document ${input.documentId} is already owned by ${owner.runtime}:${owner.instanceId}.`,
          );
        }
        return owner;
      },
    );

    await this.durableDocuments.start(registration.instanceId, input);
    return {
      documentId: input.documentId,
      runId: registration.instanceId,
      taskQueue: 'careos.durable',
      workflowId: registration.instanceId,
    };
  }

  override async signalApprovalDecision(
    approvalId: string,
    payload: ApprovalDecisionSignal,
    routing: ApprovalRuntimeRoutingContext,
  ): Promise<void> {
    const route = await this.prisma.withTenantContext(
      {
        actor: payload.actor,
        homeId: routing.homeId,
        tenantId: routing.tenantId,
      },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          SELECT
            id::text AS "id",
            instance_id AS "instanceId",
            runtime::text AS "runtime"
          FROM core.workflow_instances
          WHERE workflow_kind = 'approval'
            AND subject_type = 'approval'
            AND subject_id = ${approvalId}::uuid
          LIMIT 1
        `;
        const owner = owners[0];
        if (owner === undefined || owner.runtime === 'temporal') {
          return { runtime: 'temporal' as const };
        }

        const serializedPayload = JSON.stringify(payload);
        const payloadHash = createHash('sha256').update(serializedPayload).digest('hex');
        const commandId = randomUUID();
        const commands = await transaction.$queryRaw<WorkflowCommandIdRow[]>`
          INSERT INTO core.workflow_commands (
            id, tenant_id, home_id, workflow_instance_id, command_type,
            payload, payload_hash, status, created_at, updated_at
          ) VALUES (
            ${commandId}::uuid, ${routing.tenantId}::uuid, ${routing.homeId}::uuid,
            ${owner.id}::uuid, 'approval.decision', ${serializedPayload}::jsonb,
            ${payloadHash}, 'pending'::"core"."WorkflowCommandStatus", now(), now()
          )
          ON CONFLICT (workflow_instance_id, command_type, payload_hash)
          DO UPDATE SET payload_hash = EXCLUDED.payload_hash
          RETURNING id::text AS "id"
        `;
        const persistedCommandId = commands[0]?.id;
        if (persistedCommandId === undefined) {
          throw new Error(`Approval command for ${approvalId} was not persisted.`);
        }
        return {
          commandId: persistedCommandId,
          instanceId: owner.instanceId,
          runtime: 'durable' as const,
        };
      },
    );

    if (route.runtime === 'temporal') {
      await super.signalApprovalDecision(approvalId, payload, routing);
      return;
    }
    await this.durableApprovals.raiseDecision(route.instanceId, route.commandId);
  }

  override async startIncidentReportWorkflow(
    input: StartIncidentReportWorkflowInput,
  ): Promise<StartedIncidentWorkflow> {
    const incidentId = input.incidentId ?? randomUUID();
    const instanceId = incidentWorkflowId(incidentId);
    const actor = {
      correlationId: input.correlationId,
      kind: 'user' as const,
      userId: input.authorUserId,
    };
    if (
      !durableRuntimeEnabled(process.env.WORKFLOW_RUNTIME_INCIDENTS, 'WORKFLOW_RUNTIME_INCIDENTS')
    ) {
      const owner = await this.prisma.withTenantContext(
        { actor, homeId: input.homeId, tenantId: input.tenantId },
        async (transaction) => {
          const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
            INSERT INTO core.workflow_instances (
              id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
              runtime, instance_id, orchestration_name, orchestration_version,
              status, correlation_id, created_at, updated_at
            ) VALUES (
              gen_random_uuid(), ${input.tenantId}::uuid, ${input.homeId}::uuid,
              'incident', 'incident', ${incidentId}::uuid,
              'temporal'::"core"."WorkflowRuntimeKind", ${instanceId},
              'IncidentReportWorkflow', NULL, 'running', ${input.correlationId}, now(), now()
            )
            ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
            DO UPDATE SET instance_id = core.workflow_instances.instance_id
            RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
          `;
          return owners[0];
        },
      );
      if (owner === undefined) throw new Error(`Incident ${incidentId} owner was not persisted.`);
      if (owner.runtime !== 'temporal' || owner.instanceId !== instanceId) {
        throw new ConflictException(
          `Incident ${incidentId} is already owned by ${owner.runtime}:${owner.instanceId}.`,
        );
      }
      return super.startIncidentReportWorkflow({ ...input, incidentId });
    }
    if (
      !durableRuntimeEnabled(process.env.WORKFLOW_RUNTIME_APPROVALS, 'WORKFLOW_RUNTIME_APPROVALS')
    ) {
      throw new ConflictException(
        'WORKFLOW_RUNTIME_APPROVALS must be "durable" when incidents use Durable Task.',
      );
    }

    const registration = await this.prisma.withTenantContext(
      { actor, homeId: input.homeId, tenantId: input.tenantId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          INSERT INTO core.workflow_instances (
            id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
            runtime, instance_id, orchestration_name, orchestration_version,
            status, correlation_id, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${input.tenantId}::uuid, ${input.homeId}::uuid,
            'incident', 'incident', ${incidentId}::uuid,
            'durable'::"core"."WorkflowRuntimeKind", ${instanceId},
            ${INCIDENT_DURABLE_WORKFLOW_TYPE}, ${INCIDENT_DURABLE_VERSION},
            'running', ${input.correlationId}, now(), now()
          )
          ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
          DO UPDATE SET instance_id = core.workflow_instances.instance_id
          RETURNING id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
        `;
        const owner = owners[0];
        if (owner === undefined)
          throw new Error(`Incident workflow ${incidentId} was not registered.`);
        if (owner.runtime !== 'durable' || owner.instanceId !== instanceId) {
          throw new ConflictException(
            `Incident ${incidentId} is already owned by ${owner.runtime}:${owner.instanceId}.`,
          );
        }
        const commandId = await persistCommand(
          transaction,
          owner.id,
          input.tenantId,
          input.homeId,
          'incident.initialize',
          { ...input, incidentId },
        );
        return { commandId, owner };
      },
    );

    await this.durableIncidents.start(instanceId, {
      actor,
      authorUserId: input.authorUserId,
      formTemplate: input.formTemplate,
      homeId: input.homeId,
      incidentId,
      initialCommandId: registration.commandId,
      residentId: input.residentId,
      tenantId: input.tenantId,
    });
    return {
      incidentId,
      runId: instanceId,
      taskQueue: 'careos.durable',
      workflowId: instanceId,
    };
  }

  override async signalUpdateDraft(
    incidentId: string,
    payload: UpdateDraftSignal,
    routing: IncidentRuntimeRoutingContext,
  ): Promise<void> {
    const route = await this.routeIncidentCommand(incidentId, 'incident.update', payload, routing);
    if (route.runtime === 'temporal') {
      await super.signalUpdateDraft(incidentId, payload, routing);
      return;
    }
    await this.durableIncidents.raiseCommand(route.instanceId, route.commandId);
  }

  override async signalSubmitForApproval(
    incidentId: string,
    payload: SubmitForApprovalSignal,
    routing: IncidentRuntimeRoutingContext,
  ): Promise<void> {
    const route = await this.routeIncidentCommand(incidentId, 'incident.submit', payload, routing);
    if (route.runtime === 'temporal') {
      await super.signalSubmitForApproval(incidentId, payload, routing);
      return;
    }
    await this.durableIncidents.raiseCommand(route.instanceId, route.commandId);
  }

  override async signalExport(
    incidentId: string,
    payload: ExportSignal,
    routing: IncidentRuntimeRoutingContext,
  ): Promise<void> {
    const route = await this.routeIncidentCommand(incidentId, 'incident.export', payload, routing);
    if (route.runtime === 'temporal') {
      await super.signalExport(incidentId, payload, routing);
      return;
    }
    await this.durableIncidents.raiseCommand(route.instanceId, route.commandId);
  }

  private routeIncidentCommand(
    incidentId: string,
    commandType: string,
    payload: UpdateDraftSignal | SubmitForApprovalSignal | ExportSignal,
    routing: IncidentRuntimeRoutingContext,
  ): Promise<
    | { readonly runtime: 'temporal' }
    | { readonly commandId: string; readonly instanceId: string; readonly runtime: 'durable' }
  > {
    return this.prisma.withTenantContext(
      { actor: payload.actor, homeId: routing.homeId, tenantId: routing.tenantId },
      async (transaction) => {
        const owners = await transaction.$queryRaw<ApprovalWorkflowOwnerRow[]>`
          SELECT id::text AS "id", instance_id AS "instanceId", runtime::text AS "runtime"
            FROM core.workflow_instances
           WHERE workflow_kind = 'incident'
             AND subject_type = 'incident'
             AND subject_id = ${incidentId}::uuid
           LIMIT 1
        `;
        const owner = owners[0];
        if (owner === undefined || owner.runtime === 'temporal') {
          return { runtime: 'temporal' as const };
        }
        return {
          commandId: await persistCommand(
            transaction,
            owner.id,
            routing.tenantId,
            routing.homeId,
            commandType,
            payload,
          ),
          instanceId: owner.instanceId,
          runtime: 'durable' as const,
        };
      },
    );
  }
}

interface CommandTransaction {
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

async function persistCommand(
  transaction: CommandTransaction,
  workflowInstanceId: string,
  tenantId: string,
  homeId: string,
  commandType: string,
  payload: unknown,
): Promise<string> {
  const serializedPayload = JSON.stringify(payload);
  const payloadHash = createHash('sha256').update(serializedPayload).digest('hex');
  const commandId = randomUUID();
  const commands = await transaction.$queryRaw<WorkflowCommandIdRow[]>`
    INSERT INTO core.workflow_commands (
      id, tenant_id, home_id, workflow_instance_id, command_type,
      payload, payload_hash, status, created_at, updated_at
    ) VALUES (
      ${commandId}::uuid, ${tenantId}::uuid, ${homeId}::uuid,
      ${workflowInstanceId}::uuid, ${commandType}, ${serializedPayload}::jsonb,
      ${payloadHash}, 'pending'::"core"."WorkflowCommandStatus", now(), now()
    )
    ON CONFLICT (workflow_instance_id, command_type, payload_hash)
    DO UPDATE SET payload_hash = EXCLUDED.payload_hash
    RETURNING id::text AS "id"
  `;
  const persistedCommandId = commands[0]?.id;
  if (persistedCommandId === undefined)
    throw new Error(`${commandType} command was not persisted.`);
  return persistedCommandId;
}

function durableRuntimeEnabled(value: string | undefined, name: string): boolean {
  const runtime = value ?? 'temporal';
  if (runtime === 'temporal') return false;
  if (runtime === 'durable') return true;
  throw new Error(`${name} must be "temporal" or "durable".`);
}

const RotaAnalysisResultSchema = z
  .object({
    correlationId: z.string().min(1),
    gaps: z.array(
      z
        .object({
          detail: z.string(),
          kind: z.enum(['min_staffing', 'gender_mix', 'qualification_flag']),
          ruleId: z.string().uuid().nullable(),
          ruleName: z.string(),
          severity: z.enum(['low', 'medium', 'high']),
          shiftId: z.string().uuid(),
        })
        .strict(),
    ),
    narration: z.string(),
    periodEnd: z.string().datetime({ offset: true }),
    periodStart: z.string().datetime({ offset: true }),
    proposals: z.array(
      z
        .object({
          addUserIds: z.array(z.string().uuid()),
          reason: z.string(),
          removeUserIds: z.array(z.string().uuid()),
          resolvedGapKinds: z.array(z.enum(['min_staffing', 'gender_mix', 'qualification_flag'])),
          shiftId: z.string().uuid(),
        })
        .strict(),
    ),
    shifts: z.array(
      z
        .object({
          assignedUserIds: z.array(z.string().uuid()),
          endsAt: z.string().datetime({ offset: true }),
          id: z.string().uuid(),
          minHeadcount: z.number().int().nonnegative(),
          requiredRole: z.string(),
          startsAt: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
  })
  .strict();

function parsePersistedRotaAnalysis(
  value: unknown,
  input: RotaAnalyzeWorkflowInput,
): RotaAnalysisResult {
  const parsed = RotaAnalysisResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ServiceUnavailableException('Rota analysis produced a malformed persisted result.');
  }
  if (
    parsed.data.correlationId !== input.correlationId ||
    parsed.data.periodStart !== input.periodStart ||
    parsed.data.periodEnd !== input.periodEnd
  ) {
    throw new ServiceUnavailableException('Rota analysis result does not match the request.');
  }
  return parsed.data;
}
