import type { IncidentFollowUpStatus } from './incident-follow-ups-workflow.js';
import type { IncidentActor } from './incidents-workflow.js';
import type { PostApprovalActionKind } from './post-approval-actions.js';

export interface IncidentFollowUpActionDescriptor {
  readonly actionId: string;
  readonly attempt: number;
  readonly kind: PostApprovalActionKind;
  readonly targetId: string;
  readonly workflowId: string;
}

export interface EnsureIncidentFollowUpActionsInput {
  readonly actor: IncidentActor;
  readonly homeId: string;
  readonly immediateRisk: boolean;
  readonly incidentId: string;
  readonly orchestrationName?: string;
  readonly orchestrationVersion?: string;
  readonly runtime?: 'durable' | 'temporal';
  readonly safeguarding: boolean;
  readonly tenantId: string;
}

export interface LoadSafeguardingContactInput {
  readonly actionId: string;
  readonly actor: IncidentActor;
  readonly homeId: string;
  readonly tenantId: string;
}

export interface LoadSafeguardingContactResult {
  readonly configured: boolean;
  readonly email?: string;
  readonly name?: string;
}

export interface TransitionIncidentFollowUpInput {
  readonly actionId: string;
  readonly actor: IncidentActor;
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly homeId: string;
  readonly status: IncidentFollowUpStatus;
  readonly targetId?: string;
  readonly tenantId: string;
}

export interface EnsureFollowUpExportBundleInput {
  readonly actionId: string;
  readonly actor: IncidentActor;
  readonly bundleId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly requestedByUserId: string;
  readonly tenantId: string;
  readonly workflowId: string;
}
