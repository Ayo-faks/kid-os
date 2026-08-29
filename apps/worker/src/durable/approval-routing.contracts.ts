import type {
  ApprovalActor,
  ApprovalDecision,
  ApprovalRole,
  ApprovalStatus,
  ApprovalSubjectType,
} from '@careos/contracts';
import {
  APPROVAL_DURABLE_EVENTS,
  APPROVAL_DURABLE_VERSION,
  APPROVAL_DURABLE_WORKFLOW_TYPE,
  approvalWorkflowId,
} from '@careos/contracts';

import { assertDurableInstanceId } from './payload-policy.js';

export const APPROVAL_ORCHESTRATION_VERSION = APPROVAL_DURABLE_VERSION;
export const APPROVAL_ROUTING_ORCHESTRATOR = APPROVAL_DURABLE_WORKFLOW_TYPE;
export const CREATE_APPROVAL_REQUEST_ACTIVITY = 'createApprovalRequestFromReferenceActivityV1';
export const APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY = 'applyApprovalDecisionCommandActivityV1';
export const APPROVAL_DECISION_EVENT = APPROVAL_DURABLE_EVENTS.decide;

export interface ApprovalRoutingOrchestratorInput {
  readonly actor: ApprovalActor;
  readonly approvalId: string;
  readonly homeId: string;
  readonly requestedByUserId: string;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly signaturesRequired: 1 | 2;
  readonly subjectId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly tenantId: string;
}

export interface ApprovalDecisionEvent {
  readonly commandId: string;
}

export interface CreateApprovalRequestFromReferenceInput extends ApprovalRoutingOrchestratorInput {
  readonly workflowId: string;
}

export interface ApplyApprovalDecisionCommandInput {
  readonly approvalId: string;
  readonly commandId: string;
  readonly homeId: string;
  readonly tenantId: string;
}

export interface DurableApprovalSignature {
  readonly decision: ApprovalDecision;
  readonly role: ApprovalRole | 'ops_admin';
  readonly userId: string;
}

export interface DurableApprovalState {
  readonly approvalId: string;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly signatures: readonly DurableApprovalSignature[];
  readonly signaturesRequired: 1 | 2;
  readonly status: ApprovalStatus;
  readonly subjectId: string;
  readonly subjectType: ApprovalSubjectType;
}

export function approvalRoutingInstanceId(approvalId: string): string {
  return assertDurableInstanceId(approvalWorkflowId(approvalId));
}
