// Shared contract between the API Temporal client and the worker approvals
// workflow. Kept dependency-free for NestJS and Temporal worker imports.

import type { ApprovalRole } from './approval-policy.js';

export const APPROVAL_WORKFLOW_TYPE = 'ApprovalRoutingWorkflow';
export const DEFAULT_APPROVALS_TASK_QUEUE = 'careos.approvals';
export const APPROVAL_DURABLE_WORKFLOW_TYPE = 'ApprovalRoutingOrchestratorV1';
export const APPROVAL_DURABLE_VERSION = '1.0.0';

export const APPROVAL_DURABLE_EVENTS = {
  decide: 'approvalDecision',
} as const;

export const APPROVAL_SIGNALS = {
  decide: 'decide',
} as const;

export const APPROVAL_QUERIES = {
  getState: 'getState',
} as const;

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalSubjectType = 'email_draft' | 'incident';

export interface ApprovalSignature {
  readonly userId: string;
  readonly role: ApprovalRole | 'ops_admin';
  readonly decision: ApprovalDecision;
  readonly decidedAt: string;
  readonly reason?: string;
}

export interface ApprovalActor {
  readonly kind: 'user' | 'agent' | 'system';
  readonly userId: string | null;
  readonly correlationId: string;
  readonly agentRunId?: string;
  readonly promptHash?: string;
}

export interface ApprovalRoutingWorkflowInput {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly title: string;
  readonly summary: string;
  readonly requestedByUserId: string;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly signaturesRequired: 1 | 2;
  readonly actor: ApprovalActor;
}

export interface ApprovalDecisionSignal {
  readonly decision: ApprovalDecision;
  readonly decidedByUserId: string;
  readonly reason?: string;
  readonly actor: ApprovalActor;
}

export interface ApprovalStateQuery {
  readonly approvalId: string;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly status: ApprovalStatus;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly signatures: readonly ApprovalSignature[];
  readonly signaturesRequired: 1 | 2;
}

export function approvalWorkflowId(approvalId: string): string {
  return `approval-${approvalId}`;
}
