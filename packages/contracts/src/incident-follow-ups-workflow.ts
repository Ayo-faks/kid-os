import type { PostApprovalActionKind } from './post-approval-actions.js';

export const INCIDENT_FOLLOW_UP_WORKFLOW_TYPE = 'IncidentFollowUpActionWorkflow';
export const INCIDENT_FOLLOW_UPS_TASK_QUEUE = 'careos.incidents';

export type IncidentFollowUpStatus =
  | 'queued'
  | 'running'
  | 'needs_configuration'
  | 'awaiting_approval'
  | 'completed'
  | 'rejected'
  | 'failed';

export interface IncidentFollowUpActionWorkflowInput {
  readonly actionId: string;
  readonly attempt: number;
  readonly correlationId: string;
  readonly emailDraftsTaskQueue?: string;
  readonly exportBundlesTaskQueue?: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly kind: PostApprovalActionKind;
  readonly requestedByUserId: string;
  readonly targetId: string;
  readonly tenantId: string;
}

export interface IncidentFollowUpActionWorkflowResult {
  readonly actionId: string;
  readonly status: IncidentFollowUpStatus;
  readonly targetId?: string;
}

export function incidentFollowUpWorkflowId(actionId: string, attempt: number): string {
  return `incident-follow-up-${actionId}-attempt-${attempt}`;
}
