import type {
  ApprovalDecisionSignal,
  ApproveSignal,
  DocIngestWorkflowInput,
  EmailDraftStateQuery,
  ExportSignal,
  HandoverStateQuery,
  IncidentFollowUpActionWorkflowInput,
  IncidentStateQuery,
  RotaAnalysisResult,
  RotaAnalyzeWorkflowInput,
  RotaPublishStateQuery,
  SubmitForApprovalSignal,
  UpdateDraftSignal,
} from '@careos/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { TemporalService } from '../temporal/temporal.service.js';

import type {
  StartedIncidentFollowUpWorkflow,
  StartedIncidentWorkflow,
  StartedDocIngestWorkflow,
  StartedEmailDraftWorkflow,
  StartedExportBundleWorkflow,
  StartedHandoverWorkflow,
  StartedPingWorkflow,
  StartedRetentionSweepWorkflow,
  StartedRotaPublishWorkflow,
  ApprovalRuntimeRoutingContext,
  IncidentRuntimeRoutingContext,
  StartEmailDraftWorkflowInput,
  StartHandoverWorkflowInput,
  StartIncidentReportWorkflowInput,
  StartRetentionSweepWorkflowInput,
  StartRotaPublishWorkflowInput,
  StartSeriousIncidentExportWorkflowInput,
  WorkflowRuntime,
} from './workflow-runtime.port.js';

@Injectable()
export class TemporalWorkflowRuntimeAdapter implements WorkflowRuntime {
  constructor(@Inject(TemporalService) private readonly temporal: TemporalService) {}

  startPingWorkflow(message?: string): Promise<StartedPingWorkflow> {
    return this.temporal.startPingWorkflow(message);
  }

  startIncidentReportWorkflow(
    input: StartIncidentReportWorkflowInput,
  ): Promise<StartedIncidentWorkflow> {
    return this.temporal.startIncidentReportWorkflow(input);
  }

  signalUpdateDraft(
    incidentId: string,
    payload: UpdateDraftSignal,
    _routing: IncidentRuntimeRoutingContext,
  ): Promise<void> {
    return this.temporal.signalUpdateDraft(incidentId, payload);
  }

  signalSubmitForApproval(
    incidentId: string,
    payload: SubmitForApprovalSignal,
    _routing: IncidentRuntimeRoutingContext,
  ): Promise<void> {
    return this.temporal.signalSubmitForApproval(incidentId, payload);
  }

  signalApprove(incidentId: string, payload: ApproveSignal): Promise<void> {
    return this.temporal.signalApprove(incidentId, payload);
  }

  signalExport(
    incidentId: string,
    payload: ExportSignal,
    _routing: IncidentRuntimeRoutingContext,
  ): Promise<void> {
    return this.temporal.signalExport(incidentId, payload);
  }

  queryIncidentState(incidentId: string): Promise<IncidentStateQuery> {
    return this.temporal.queryIncidentState(incidentId);
  }

  startIncidentFollowUpActionWorkflow(
    input: IncidentFollowUpActionWorkflowInput,
  ): Promise<StartedIncidentFollowUpWorkflow> {
    return this.temporal.startIncidentFollowUpActionWorkflow(input);
  }

  signalApprovalDecision(
    approvalId: string,
    payload: ApprovalDecisionSignal,
    _routing: ApprovalRuntimeRoutingContext,
  ): Promise<void> {
    return this.temporal.signalApprovalDecision(approvalId, payload);
  }

  startHandoverWorkflow(input: StartHandoverWorkflowInput): Promise<StartedHandoverWorkflow> {
    return this.temporal.startHandoverWorkflow(input);
  }

  queryHandoverState(handoverId: string): Promise<HandoverStateQuery> {
    return this.temporal.queryHandoverState(handoverId);
  }

  startEmailDraftWorkflow(input: StartEmailDraftWorkflowInput): Promise<StartedEmailDraftWorkflow> {
    return this.temporal.startEmailDraftWorkflow(input);
  }

  queryEmailDraftState(emailDraftId: string): Promise<EmailDraftStateQuery> {
    return this.temporal.queryEmailDraftState(emailDraftId);
  }

  executeRotaAnalyzeWorkflow(input: RotaAnalyzeWorkflowInput): Promise<RotaAnalysisResult> {
    return this.temporal.executeRotaAnalyzeWorkflow(input);
  }

  startRotaPublishWorkflow(
    input: StartRotaPublishWorkflowInput,
  ): Promise<StartedRotaPublishWorkflow> {
    return this.temporal.startRotaPublishWorkflow(input);
  }

  queryRotaPublishState(publicationId: string): Promise<RotaPublishStateQuery> {
    return this.temporal.queryRotaPublishState(publicationId);
  }

  startDocIngestWorkflow(input: DocIngestWorkflowInput): Promise<StartedDocIngestWorkflow> {
    return this.temporal.startDocIngestWorkflow(input);
  }

  startSeriousIncidentExportWorkflow(
    input: StartSeriousIncidentExportWorkflowInput,
  ): Promise<StartedExportBundleWorkflow> {
    return this.temporal.startSeriousIncidentExportWorkflow(input);
  }

  startRetentionSweepWorkflow(
    input: StartRetentionSweepWorkflowInput,
  ): Promise<StartedRetentionSweepWorkflow> {
    return this.temporal.startRetentionSweepWorkflow(input);
  }
}
