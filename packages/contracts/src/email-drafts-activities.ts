import type {
  EmailDraftActor,
  EmailDraftRecipientInput,
  EmailDraftSourceInput,
  EmailDraftStatus,
  EmailSensitivity,
} from './email-drafts-workflow.js';
import type { ValidationError } from './incidents-activities.js';

export interface DraftEmailInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly correlationId: string;
  readonly source: EmailDraftSourceInput;
  readonly recipient: EmailDraftRecipientInput;
  readonly instructions: string;
  readonly agentRunId?: string;
}

export interface DraftEmailResult {
  readonly formData: Record<string, unknown>;
  readonly subject: string;
  readonly body: string;
  readonly sensitivity: EmailSensitivity;
  readonly sensitivityReasons: readonly string[];
  readonly missingMandatory: readonly string[];
  readonly confidence: number;
  readonly promptHash: string;
  readonly refused: boolean;
}

export interface ValidateEmailDraftInput {
  readonly formData: Record<string, unknown>;
}

export interface ValidateEmailDraftResult {
  readonly valid: boolean;
  readonly missingMandatory: readonly string[];
  readonly errors: readonly ValidationError[];
}

export interface PersistEmailDraftInput {
  readonly emailDraftId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly workflowId: string;
  readonly source: EmailDraftSourceInput;
  readonly recipient: EmailDraftRecipientInput;
  readonly subject: string;
  readonly body: string;
  readonly sensitivity: EmailSensitivity;
  readonly sensitivityReasons: readonly string[];
  readonly status: EmailDraftStatus;
  readonly authorUserId: string;
  readonly actor: EmailDraftActor;
}

export interface PersistEmailDraftResult {
  readonly emailDraftId: string;
  readonly status: EmailDraftStatus;
  readonly sensitivity: EmailSensitivity;
}

export interface DispatchEmailDraftNotificationsInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly emailDraftId: string;
  readonly status: EmailDraftStatus;
  readonly sensitivity: EmailSensitivity;
  readonly actor: EmailDraftActor;
}

export interface DispatchEmailDraftNotificationsResult {
  readonly dispatched: boolean;
  readonly outboxId?: string;
}
