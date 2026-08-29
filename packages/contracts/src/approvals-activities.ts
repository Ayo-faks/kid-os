import type { ApprovalRole } from './approval-policy.js';
import type {
  ApprovalActor,
  ApprovalDecision,
  ApprovalSignature,
  ApprovalStatus,
  ApprovalSubjectType,
} from './approvals-workflow.js';
import type { EmailDraftStatus } from './email-drafts-workflow.js';
import type { IncidentStatus } from './incidents-workflow.js';

export interface CreateApprovalRequestInput {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly workflowId: string;
  readonly runtime: 'temporal' | 'durable';
  readonly orchestrationName: string;
  readonly orchestrationVersion?: string;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly title: string;
  readonly summary: string;
  readonly requestedByUserId: string;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly signaturesRequired: 1 | 2;
  readonly actor: ApprovalActor;
}

export interface CreateApprovalRequestResult {
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly signatures: readonly ApprovalSignature[];
  readonly signaturesRequired: 1 | 2;
}

export interface ApplyApprovalDecisionInput {
  readonly approvalId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly decision: ApprovalDecision;
  readonly decidedByUserId: string;
  readonly reason?: string;
  readonly actor: ApprovalActor;
}

export interface ApplyApprovalDecisionResult {
  readonly approvalId: string;
  readonly status: ApprovalStatus;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly signatures: readonly ApprovalSignature[];
  readonly signaturesRequired: 1 | 2;
  readonly emailDraftStatus?: EmailDraftStatus;
  readonly incidentStatus?: IncidentStatus;
  readonly outboxId?: string;
}

export interface ResolveApprovalRequirementInput {
  readonly skill: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

export interface ResolveApprovalRequirementResult {
  readonly level: 'none' | 'confirm' | 'dual_sign_off';
  readonly requiredRoles: readonly ApprovalRole[];
  readonly signaturesRequired: 0 | 1 | 2;
}
