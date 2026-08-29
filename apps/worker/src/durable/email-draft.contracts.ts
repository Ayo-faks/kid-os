import type {
  EmailDraftDurableWorkflowInput,
  EmailDraftStatus,
  EmailSensitivity,
} from '@careos/contracts';
import {
  EMAIL_DRAFT_DURABLE_VERSION,
  EMAIL_DRAFT_DURABLE_WORKFLOW_TYPE,
  emailDraftWorkflowId,
} from '@careos/contracts';

import type { ApprovalRoutingOrchestratorInput } from './approval-routing.contracts.js';
import { assertDurableInstanceId } from './payload-policy.js';

export const EMAIL_DRAFT_ORCHESTRATION_VERSION = EMAIL_DRAFT_DURABLE_VERSION;
export const EMAIL_DRAFT_ORCHESTRATOR = EMAIL_DRAFT_DURABLE_WORKFLOW_TYPE;
export const PROCESS_EMAIL_DRAFT_COMMAND_ACTIVITY = 'processEmailDraftCommandActivityV1';
export const FINALIZE_EMAIL_DRAFT_FAILURE_ACTIVITY = 'finalizeEmailDraftFailureActivityV1';
export const START_EMAIL_DRAFT_APPROVAL_ACTIVITY = 'startEmailDraftApprovalActivityV1';

export type EmailDraftOrchestratorInput = EmailDraftDurableWorkflowInput;

export interface DurableEmailDraftState {
  readonly emailDraftId: string;
  readonly missingMandatory: readonly string[];
  readonly outcomeCode?: 'processing-failed' | 'refused' | 'validation-failed';
  readonly sensitivity: EmailSensitivity | null;
  readonly status: EmailDraftStatus | 'failed';
}

export type ProcessEmailDraftCommandResult =
  | {
      readonly kind: 'state';
      readonly state: DurableEmailDraftState;
    }
  | {
      readonly approval: ApprovalRoutingOrchestratorInput;
      readonly kind: 'await_approval';
      readonly state: DurableEmailDraftState;
    };

export interface FinalizeEmailDraftFailureInput {
  readonly actor: EmailDraftDurableWorkflowInput['actor'];
  readonly commandId: string;
  readonly emailDraftId: string;
  readonly homeId: string;
  readonly tenantId: string;
}

export function emailDraftInstanceId(emailDraftId: string): string {
  return assertDurableInstanceId(emailDraftWorkflowId(emailDraftId));
}
