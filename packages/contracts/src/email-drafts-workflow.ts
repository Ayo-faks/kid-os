// Shared contract between the API Temporal client and the worker email-draft
// workflow. Kept dependency-free for both NestJS and Temporal worker imports.

export const EMAIL_DRAFT_WORKFLOW_TYPE = 'EmailDraftWorkflow';
export const EMAIL_DRAFT_DURABLE_WORKFLOW_TYPE = 'EmailDraftOrchestratorV1';
export const EMAIL_DRAFT_DURABLE_VERSION = '1.0.0';
export const EMAIL_DRAFTS_TASK_QUEUE = 'careos.emails';

export const EMAIL_DRAFT_QUERIES = {
  getState: 'getState',
} as const;

export type EmailDraftStatus = 'draft' | 'needs_review' | 'approved' | 'rejected' | 'sent_stub';
export type EmailSensitivity = 'routine' | 'sensitive';
export type EmailSourceKind = 'incident' | 'handover' | 'general';

export interface EmailDraftActor {
  readonly kind: 'user' | 'agent' | 'system';
  readonly userId: string | null;
  readonly correlationId: string;
  readonly agentRunId?: string;
  readonly promptHash?: string;
}

export interface EmailDraftRecipientInput {
  readonly name?: string;
  readonly email: string;
  readonly role?: string;
}

export interface EmailDraftSourceInput {
  readonly kind: EmailSourceKind;
  readonly id?: string;
  readonly summary: string;
}

export interface EmailDraftWorkflowInput {
  readonly actor?: EmailDraftActor;
  readonly emailDraftId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly authorUserId: string;
  readonly correlationId: string;
  readonly approvalTaskQueue?: string;
  readonly source: EmailDraftSourceInput;
  readonly recipient: EmailDraftRecipientInput;
  readonly instructions: string;
  readonly preparedDraft?: {
    readonly body: string;
    readonly sensitivity: EmailSensitivity;
    readonly sensitivityReasons: readonly string[];
    readonly subject: string;
  };
}

export interface EmailDraftDurableWorkflowInput {
  readonly actor: EmailDraftActor;
  readonly authorUserId: string;
  readonly commandId: string;
  readonly emailDraftId: string;
  readonly homeId: string;
  readonly tenantId: string;
}

export interface EmailDraftStateQuery {
  readonly emailDraftId: string;
  readonly status: EmailDraftStatus;
  readonly sensitivity: EmailSensitivity | null;
  readonly missingMandatory: readonly string[];
}

export function emailDraftWorkflowId(emailDraftId: string): string {
  return `email-draft-${emailDraftId}`;
}
