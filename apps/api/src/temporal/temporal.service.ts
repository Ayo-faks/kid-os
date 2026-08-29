import { randomUUID } from 'node:crypto';

import {
  APPROVAL_SIGNALS,
  DEFAULT_APPROVALS_TASK_QUEUE,
  DOCUMENTS_TASK_QUEUE,
  EMAIL_DRAFT_QUERIES,
  EMAIL_DRAFTS_TASK_QUEUE,
  EMAIL_DRAFT_WORKFLOW_TYPE,
  EXPORT_BUNDLES_TASK_QUEUE,
  HANDOVER_QUERIES,
  HANDOVER_WORKFLOW_TYPE,
  INCIDENT_FOLLOW_UP_WORKFLOW_TYPE,
  INCIDENT_QUERIES,
  INCIDENT_SIGNALS,
  INCIDENT_WORKFLOW_TYPE,
  RETENTION_TASK_QUEUE,
  ROTA_ANALYZE_WORKFLOW_TYPE,
  ROTA_PUBLISH_WORKFLOW_TYPE,
  ROTA_QUERIES,
  SERIOUS_INCIDENT_EXPORT_WORKFLOW_TYPE,
  approvalWorkflowId,
  documentIngestWorkflowId,
  emailDraftWorkflowId,
  handoverWorkflowId,
  incidentFollowUpWorkflowId,
  incidentWorkflowId,
  rotaAnalyzeWorkflowId,
  rotaPublishWorkflowId,
  seriousIncidentExportWorkflowId,
  type ApproveSignal,
  type ApprovalDecisionSignal,
  type DocIngestWorkflowInput,
  type EmailDraftStateQuery,
  type EmailDraftWorkflowInput,
  type ExportSignal,
  type HandoverStateQuery,
  type HandoverWorkflowInput,
  type IncidentReportWorkflowInput,
  type IncidentFollowUpActionWorkflowInput,
  type IncidentStateQuery,
  type RotaAnalysisResult,
  type RotaAnalyzeWorkflowInput,
  type RotaPublishStateQuery,
  type RotaPublishWorkflowInput,
  type RetentionSweepWorkflowInput,
  type SeriousIncidentExportWorkflowInput,
  type SubmitForApprovalSignal,
  type UpdateDraftSignal,
} from '@careos/contracts';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';

export const DEFAULT_TEMPORAL_ADDRESS = 'temporal:7233';
export const DEFAULT_TEMPORAL_NAMESPACE = 'default';
export const DEFAULT_TASK_QUEUE = 'careos.phase0';
export const DEFAULT_INCIDENTS_TASK_QUEUE = 'careos.incidents';
export const DEFAULT_HANDOVERS_TASK_QUEUE = 'careos.handovers';
export const DEFAULT_ROTA_TASK_QUEUE = 'careos.rota';
export const DEFAULT_DOCUMENTS_TASK_QUEUE = DOCUMENTS_TASK_QUEUE;
export const DEFAULT_EXPORT_BUNDLES_TASK_QUEUE = EXPORT_BUNDLES_TASK_QUEUE;
export const DEFAULT_RETENTION_TASK_QUEUE = RETENTION_TASK_QUEUE;

export interface StartedPingWorkflow {
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface StartedIncidentWorkflow {
  readonly incidentId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface StartedIncidentFollowUpWorkflow {
  readonly actionId: string;
  readonly attempt: number;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface StartedHandoverWorkflow {
  readonly handoverId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface StartedEmailDraftWorkflow {
  readonly emailDraftId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface StartedRotaPublishWorkflow {
  readonly publicationId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface StartedDocIngestWorkflow {
  readonly documentId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface StartedExportBundleWorkflow {
  readonly bundleId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface StartedRetentionSweepWorkflow {
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

@Injectable()
export class TemporalService implements OnModuleDestroy {
  private readonly namespace = process.env.TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
  private readonly taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE;
  private readonly incidentsTaskQueue =
    process.env.TEMPORAL_INCIDENTS_TASK_QUEUE ?? DEFAULT_INCIDENTS_TASK_QUEUE;
  private readonly handoversTaskQueue =
    process.env.TEMPORAL_HANDOVERS_TASK_QUEUE ?? DEFAULT_HANDOVERS_TASK_QUEUE;
  private readonly emailDraftsTaskQueue =
    process.env.TEMPORAL_EMAIL_DRAFTS_TASK_QUEUE ?? EMAIL_DRAFTS_TASK_QUEUE;
  private readonly approvalsTaskQueue =
    process.env.TEMPORAL_APPROVALS_TASK_QUEUE ?? DEFAULT_APPROVALS_TASK_QUEUE;
  private readonly rotaTaskQueue = process.env.TEMPORAL_ROTA_TASK_QUEUE ?? DEFAULT_ROTA_TASK_QUEUE;
  private readonly documentsTaskQueue =
    process.env.TEMPORAL_DOCUMENTS_TASK_QUEUE ?? DEFAULT_DOCUMENTS_TASK_QUEUE;
  private readonly exportBundlesTaskQueue =
    process.env.TEMPORAL_EXPORT_BUNDLES_TASK_QUEUE ?? DEFAULT_EXPORT_BUNDLES_TASK_QUEUE;
  private readonly retentionTaskQueue =
    process.env.TEMPORAL_RETENTION_TASK_QUEUE ?? DEFAULT_RETENTION_TASK_QUEUE;
  private readonly temporalAddress = process.env.TEMPORAL_HOST ?? DEFAULT_TEMPORAL_ADDRESS;
  private clientPromise: Promise<Client> | undefined;
  private connectionPromise: Promise<Connection> | undefined;

  async startPingWorkflow(message = 'hello from NestJS'): Promise<StartedPingWorkflow> {
    const client = await this.getClient();
    const workflowId = `phase0-ping-${randomUUID()}`;
    const handle = await client.workflow.start('PingWorkflow', {
      args: [{ message }],
      taskQueue: this.taskQueue,
      workflowId,
    });

    return {
      runId: handle.firstExecutionRunId,
      taskQueue: this.taskQueue,
      workflowId: handle.workflowId,
    };
  }

  async startIncidentReportWorkflow(
    input: Omit<IncidentReportWorkflowInput, 'incidentId'> & { readonly incidentId?: string },
  ): Promise<StartedIncidentWorkflow> {
    const incidentId = input.incidentId ?? randomUUID();
    const workflowId = incidentWorkflowId(incidentId);
    const client = await this.getClient();
    const handle = await client.workflow.start(INCIDENT_WORKFLOW_TYPE, {
      args: [
        {
          ...input,
          approvalTaskQueue: this.approvalsTaskQueue,
          incidentId,
        } satisfies IncidentReportWorkflowInput,
      ],
      taskQueue: this.incidentsTaskQueue,
      workflowId,
    });

    return {
      incidentId,
      runId: handle.firstExecutionRunId,
      taskQueue: this.incidentsTaskQueue,
      workflowId: handle.workflowId,
    };
  }

  async startIncidentFollowUpActionWorkflow(
    input: IncidentFollowUpActionWorkflowInput,
  ): Promise<StartedIncidentFollowUpWorkflow> {
    const workflowId = incidentFollowUpWorkflowId(input.actionId, input.attempt);
    const client = await this.getClient();
    const handle = await client.workflow.start(INCIDENT_FOLLOW_UP_WORKFLOW_TYPE, {
      args: [input],
      taskQueue: this.incidentsTaskQueue,
      workflowId,
    });

    return {
      actionId: input.actionId,
      attempt: input.attempt,
      runId: handle.firstExecutionRunId,
      taskQueue: this.incidentsTaskQueue,
      workflowId: handle.workflowId,
    };
  }

  async startHandoverWorkflow(
    input: Omit<HandoverWorkflowInput, 'handoverId'> & { readonly handoverId?: string },
  ): Promise<StartedHandoverWorkflow> {
    const handoverId = input.handoverId ?? randomUUID();
    const workflowId = handoverWorkflowId(handoverId);
    const client = await this.getClient();
    const handle = await client.workflow.start(HANDOVER_WORKFLOW_TYPE, {
      args: [{ ...input, handoverId } satisfies HandoverWorkflowInput],
      taskQueue: this.handoversTaskQueue,
      workflowId,
    });

    return {
      handoverId,
      runId: handle.firstExecutionRunId,
      taskQueue: this.handoversTaskQueue,
      workflowId: handle.workflowId,
    };
  }

  async signalUpdateDraft(incidentId: string, payload: UpdateDraftSignal): Promise<void> {
    await this.signalIncident(incidentId, INCIDENT_SIGNALS.updateDraft, payload);
  }

  async signalSubmitForApproval(
    incidentId: string,
    payload: SubmitForApprovalSignal,
  ): Promise<void> {
    await this.signalIncident(incidentId, INCIDENT_SIGNALS.submitForApproval, payload);
  }

  async signalApprove(incidentId: string, payload: ApproveSignal): Promise<void> {
    await this.signalIncident(incidentId, INCIDENT_SIGNALS.approve, payload);
  }

  async signalExport(incidentId: string, payload: ExportSignal): Promise<void> {
    await this.signalIncident(incidentId, INCIDENT_SIGNALS.exportPdf, payload);
  }

  async queryIncidentState(incidentId: string): Promise<IncidentStateQuery> {
    const client = await this.getClient();
    const handle = client.workflow.getHandle(incidentWorkflowId(incidentId));
    return handle.query<IncidentStateQuery>(INCIDENT_QUERIES.getState);
  }

  async queryHandoverState(handoverId: string): Promise<HandoverStateQuery> {
    const client = await this.getClient();
    const handle = client.workflow.getHandle(handoverWorkflowId(handoverId));
    return handle.query<HandoverStateQuery>(HANDOVER_QUERIES.getState);
  }

  async startEmailDraftWorkflow(
    input: Omit<EmailDraftWorkflowInput, 'emailDraftId'> & { readonly emailDraftId?: string },
  ): Promise<StartedEmailDraftWorkflow> {
    const emailDraftId = input.emailDraftId ?? randomUUID();
    const workflowId = emailDraftWorkflowId(emailDraftId);
    const client = await this.getClient();
    const handle = await client.workflow.start(EMAIL_DRAFT_WORKFLOW_TYPE, {
      args: [
        {
          ...input,
          approvalTaskQueue: this.approvalsTaskQueue,
          emailDraftId,
        } satisfies EmailDraftWorkflowInput,
      ],
      taskQueue: this.emailDraftsTaskQueue,
      workflowId,
    });

    return {
      emailDraftId,
      runId: handle.firstExecutionRunId,
      taskQueue: this.emailDraftsTaskQueue,
      workflowId: handle.workflowId,
    };
  }

  async queryEmailDraftState(emailDraftId: string): Promise<EmailDraftStateQuery> {
    const client = await this.getClient();
    const handle = client.workflow.getHandle(emailDraftWorkflowId(emailDraftId));
    return handle.query<EmailDraftStateQuery>(EMAIL_DRAFT_QUERIES.getState);
  }

  async signalApprovalDecision(approvalId: string, payload: ApprovalDecisionSignal): Promise<void> {
    const client = await this.getClient();
    const handle = client.workflow.getHandle(approvalWorkflowId(approvalId));
    await handle.signal(APPROVAL_SIGNALS.decide, payload);
  }

  async executeRotaAnalyzeWorkflow(input: RotaAnalyzeWorkflowInput): Promise<RotaAnalysisResult> {
    const client = await this.getClient();
    const workflowId = rotaAnalyzeWorkflowId(input.correlationId);
    return client.workflow.execute<(arg: RotaAnalyzeWorkflowInput) => Promise<RotaAnalysisResult>>(
      ROTA_ANALYZE_WORKFLOW_TYPE,
      {
        args: [input],
        taskQueue: this.rotaTaskQueue,
        workflowId,
      },
    );
  }

  async startRotaPublishWorkflow(
    input: Omit<RotaPublishWorkflowInput, 'publicationId'> & { readonly publicationId?: string },
  ): Promise<StartedRotaPublishWorkflow> {
    const publicationId = input.publicationId ?? randomUUID();
    const workflowId = rotaPublishWorkflowId(publicationId);
    const client = await this.getClient();
    const handle = await client.workflow.start(ROTA_PUBLISH_WORKFLOW_TYPE, {
      args: [{ ...input, publicationId } satisfies RotaPublishWorkflowInput],
      taskQueue: this.rotaTaskQueue,
      workflowId,
    });

    return {
      publicationId,
      runId: handle.firstExecutionRunId,
      taskQueue: this.rotaTaskQueue,
      workflowId: handle.workflowId,
    };
  }

  async queryRotaPublishState(publicationId: string): Promise<RotaPublishStateQuery> {
    const client = await this.getClient();
    const handle = client.workflow.getHandle(rotaPublishWorkflowId(publicationId));
    return handle.query<RotaPublishStateQuery>(ROTA_QUERIES.getState);
  }

  async startDocIngestWorkflow(input: DocIngestWorkflowInput): Promise<StartedDocIngestWorkflow> {
    const workflowId = documentIngestWorkflowId(input.documentId);
    const client = await this.getClient();
    let runId: string;
    try {
      const handle = await client.workflow.start('DocIngestWorkflow', {
        args: [input],
        taskQueue: this.documentsTaskQueue,
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        workflowId,
      });
      runId = handle.firstExecutionRunId;
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      runId = (await client.workflow.getHandle(workflowId).describe()).runId;
    }

    return {
      documentId: input.documentId,
      runId,
      taskQueue: this.documentsTaskQueue,
      workflowId,
    };
  }

  async startSeriousIncidentExportWorkflow(
    input: SeriousIncidentExportWorkflowInput,
  ): Promise<StartedExportBundleWorkflow> {
    const workflowId = seriousIncidentExportWorkflowId(input.bundleId);
    const client = await this.getClient();
    const handle = await client.workflow.start(SERIOUS_INCIDENT_EXPORT_WORKFLOW_TYPE, {
      args: [input],
      taskQueue: this.exportBundlesTaskQueue,
      workflowId,
    });

    return {
      bundleId: input.bundleId,
      runId: handle.firstExecutionRunId,
      taskQueue: this.exportBundlesTaskQueue,
      workflowId: handle.workflowId,
    };
  }

  async startRetentionSweepWorkflow(
    input: RetentionSweepWorkflowInput,
  ): Promise<StartedRetentionSweepWorkflow> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const workflowId = `retention-sweep-${nowIso}`;
    const client = await this.getClient();
    const handle = await client.workflow.start('RetentionSweepWorkflow', {
      args: [{ ...input, nowIso } satisfies RetentionSweepWorkflowInput],
      taskQueue: this.retentionTaskQueue,
      workflowId,
    });

    return {
      runId: handle.firstExecutionRunId,
      taskQueue: this.retentionTaskQueue,
      workflowId: handle.workflowId,
    };
  }

  async onModuleDestroy(): Promise<void> {
    const connection = await this.connectionPromise;
    await connection?.close();
  }

  private async signalIncident(
    incidentId: string,
    signalName: string,
    payload: unknown,
  ): Promise<void> {
    const client = await this.getClient();
    const handle = client.workflow.getHandle(incidentWorkflowId(incidentId));
    await handle.signal(signalName, payload);
  }

  private async getClient(): Promise<Client> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  private async createClient(): Promise<Client> {
    const connection = await this.getConnection();
    return new Client({ connection, namespace: this.namespace });
  }

  private async getConnection(): Promise<Connection> {
    this.connectionPromise ??= Connection.connect({ address: this.temporalAddress });
    return this.connectionPromise;
  }
}
