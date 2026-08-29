import type {
  ApprovalDecisionSignal,
  ApproveSignal,
  DocIngestWorkflowInput,
  EmailDraftStateQuery,
  EmailDraftWorkflowInput,
  ExportSignal,
  HandoverStateQuery,
  HandoverWorkflowInput,
  IncidentActor,
  IncidentFollowUpActionWorkflowInput,
  IncidentReportWorkflowInput,
  IncidentStateQuery,
  RotaAnalysisResult,
  RotaAnalyzeWorkflowInput,
  RotaPublishStateQuery,
  RotaPublishWorkflowInput,
  SubmitForApprovalSignal,
  UpdateDraftSignal,
} from '@careos/contracts';

export const WORKFLOW_RUNTIME = Symbol('WORKFLOW_RUNTIME');

export interface StartedPingWorkflow {
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface PingWorkflowRuntime {
  startPingWorkflow(message?: string): Promise<StartedPingWorkflow>;
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

export type StartIncidentReportWorkflowInput = Omit<IncidentReportWorkflowInput, 'incidentId'> & {
  readonly incidentId?: string;
};

export interface IncidentWorkflowRuntime {
  queryIncidentState(incidentId: string): Promise<IncidentStateQuery>;
  signalApprove(incidentId: string, payload: ApproveSignal): Promise<void>;
  signalExport(
    incidentId: string,
    payload: ExportSignal,
    routing: IncidentRuntimeRoutingContext,
  ): Promise<void>;
  signalSubmitForApproval(
    incidentId: string,
    payload: SubmitForApprovalSignal,
    routing: IncidentRuntimeRoutingContext,
  ): Promise<void>;
  signalUpdateDraft(
    incidentId: string,
    payload: UpdateDraftSignal,
    routing: IncidentRuntimeRoutingContext,
  ): Promise<void>;
  startIncidentFollowUpActionWorkflow(
    input: IncidentFollowUpActionWorkflowInput,
  ): Promise<StartedIncidentFollowUpWorkflow>;
  startIncidentReportWorkflow(
    input: StartIncidentReportWorkflowInput,
  ): Promise<StartedIncidentWorkflow>;
}

export interface IncidentRuntimeRoutingContext {
  readonly homeId: string;
  readonly tenantId: string;
}

export interface ApprovalWorkflowRuntime {
  signalApprovalDecision(
    approvalId: string,
    payload: ApprovalDecisionSignal,
    routing: ApprovalRuntimeRoutingContext,
  ): Promise<void>;
}

export interface ApprovalRuntimeRoutingContext {
  readonly homeId: string;
  readonly tenantId: string;
}

export interface StartedHandoverWorkflow {
  readonly handoverId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export type StartHandoverWorkflowInput = Omit<HandoverWorkflowInput, 'handoverId'> & {
  readonly handoverId?: string;
};

export interface HandoverWorkflowRuntime {
  queryHandoverState(handoverId: string): Promise<HandoverStateQuery>;
  startHandoverWorkflow(input: StartHandoverWorkflowInput): Promise<StartedHandoverWorkflow>;
}

export interface StartedEmailDraftWorkflow {
  readonly emailDraftId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export type StartEmailDraftWorkflowInput = Omit<EmailDraftWorkflowInput, 'emailDraftId'> & {
  readonly emailDraftId?: string;
};

export interface EmailDraftWorkflowRuntime {
  queryEmailDraftState(emailDraftId: string): Promise<EmailDraftStateQuery>;
  startEmailDraftWorkflow(input: StartEmailDraftWorkflowInput): Promise<StartedEmailDraftWorkflow>;
}

export interface StartedRotaPublishWorkflow {
  readonly publicationId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export type StartRotaPublishWorkflowInput = Omit<RotaPublishWorkflowInput, 'publicationId'> & {
  readonly publicationId?: string;
};

export interface RotaWorkflowRuntime {
  executeRotaAnalyzeWorkflow(input: RotaAnalyzeWorkflowInput): Promise<RotaAnalysisResult>;
  queryRotaPublishState(publicationId: string): Promise<RotaPublishStateQuery>;
  startRotaPublishWorkflow(
    input: StartRotaPublishWorkflowInput,
  ): Promise<StartedRotaPublishWorkflow>;
}

export interface StartedDocIngestWorkflow {
  readonly documentId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface DocumentWorkflowRuntime {
  startDocIngestWorkflow(input: DocIngestWorkflowInput): Promise<StartedDocIngestWorkflow>;
}

export interface StartSeriousIncidentExportWorkflowInput {
  readonly actor: IncidentActor;
  readonly bundleId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly tenantId: string;
}

export interface StartedExportBundleWorkflow {
  readonly bundleId: string;
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface ExportBundleWorkflowRuntime {
  startSeriousIncidentExportWorkflow(
    input: StartSeriousIncidentExportWorkflowInput,
  ): Promise<StartedExportBundleWorkflow>;
}

export interface StartRetentionSweepWorkflowInput {
  readonly actor: IncidentActor;
  readonly correlationId?: string;
  readonly homeId: string;
  readonly nowIso: string;
  readonly tenantId: string;
}

export interface StartedRetentionSweepWorkflow {
  readonly runId: string;
  readonly taskQueue: string;
  readonly workflowId: string;
}

export interface RetentionWorkflowRuntime {
  startRetentionSweepWorkflow(
    input: StartRetentionSweepWorkflowInput,
  ): Promise<StartedRetentionSweepWorkflow>;
}

export interface WorkflowRuntime
  extends
    PingWorkflowRuntime,
    IncidentWorkflowRuntime,
    ApprovalWorkflowRuntime,
    HandoverWorkflowRuntime,
    EmailDraftWorkflowRuntime,
    RotaWorkflowRuntime,
    DocumentWorkflowRuntime,
    ExportBundleWorkflowRuntime,
    RetentionWorkflowRuntime {}
