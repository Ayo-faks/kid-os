import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import type { ApprovalRoutingOrchestratorInput } from '../approval-routing.contracts.js';
import {
  type DurableEmailDraftState,
  EMAIL_DRAFT_ORCHESTRATION_VERSION,
  EMAIL_DRAFT_ORCHESTRATOR,
  type EmailDraftOrchestratorInput,
  FINALIZE_EMAIL_DRAFT_FAILURE_ACTIVITY,
  type FinalizeEmailDraftFailureInput,
  PROCESS_EMAIL_DRAFT_COMMAND_ACTIVITY,
  type ProcessEmailDraftCommandResult,
  START_EMAIL_DRAFT_APPROVAL_ACTIVITY,
} from '../email-draft.contracts.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

const EMAIL_DRAFT_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 1_000,
  maxNumberOfAttempts: 5,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* emailDraftOrchestrator(
  context: OrchestrationContext,
  input: EmailDraftOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableEmailDraftState, unknown> {
  assertDurableInstanceId(context.instanceId);
  assertDurablePayload(input, 'emailDraft');

  let state: DurableEmailDraftState;
  try {
    const processedValue = yield context.callActivity<
      EmailDraftOrchestratorInput,
      ProcessEmailDraftCommandResult
    >(PROCESS_EMAIL_DRAFT_COMMAND_ACTIVITY, input, {
      retry: EMAIL_DRAFT_RETRY,
      version: EMAIL_DRAFT_ORCHESTRATION_VERSION,
    });
    const processed = parseCommandResult(processedValue, input.emailDraftId);
    state = processed.state;
    if (processed.kind === 'await_approval') {
      yield context.callActivity<ApprovalRoutingOrchestratorInput, string>(
        START_EMAIL_DRAFT_APPROVAL_ACTIVITY,
        processed.approval,
        { retry: EMAIL_DRAFT_RETRY, version: EMAIL_DRAFT_ORCHESTRATION_VERSION },
      );
    }
  } catch {
    state = failedState(input.emailDraftId);
    yield context.callActivity<FinalizeEmailDraftFailureInput, void>(
      FINALIZE_EMAIL_DRAFT_FAILURE_ACTIVITY,
      {
        actor: input.actor,
        commandId: input.commandId,
        emailDraftId: input.emailDraftId,
        homeId: input.homeId,
        tenantId: input.tenantId,
      },
      { retry: EMAIL_DRAFT_RETRY, version: EMAIL_DRAFT_ORCHESTRATION_VERSION },
    );
  }

  context.setCustomStatus(state);
  if (state.status === 'failed') {
    throw new Error('Email draft processing failed.');
  }
  return state;
}

export const EmailDraftOrchestrator = emailDraftOrchestrator as unknown as TOrchestrator;

export const EMAIL_DRAFT_ORCHESTRATOR_NAME = EMAIL_DRAFT_ORCHESTRATOR;

function parseCommandResult(value: unknown, emailDraftId: string): ProcessEmailDraftCommandResult {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('state' in value)) {
    throw new Error('Email draft activity returned an invalid result.');
  }
  const keys = Object.keys(value);
  const state = parseState(value.state, emailDraftId);
  if (value.kind === 'state') {
    if (keys.some((key) => !['kind', 'state'].includes(key))) {
      throw new Error('Email draft activity returned an invalid result.');
    }
    return { kind: 'state', state };
  }
  if (value.kind !== 'await_approval' || !('approval' in value)) {
    throw new Error('Email draft activity returned an invalid result.');
  }
  if (keys.some((key) => !['approval', 'kind', 'state'].includes(key))) {
    throw new Error('Email draft activity returned an invalid result.');
  }
  return {
    approval: parseApprovalInput(value.approval, emailDraftId),
    kind: 'await_approval',
    state,
  };
}

function parseState(value: unknown, emailDraftId: string): DurableEmailDraftState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Email draft activity returned an invalid state.');
  }
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).some(
      (key) =>
        !['emailDraftId', 'missingMandatory', 'outcomeCode', 'sensitivity', 'status'].includes(key),
    ) ||
    state.emailDraftId !== emailDraftId ||
    !isStatus(state.status) ||
    (state.sensitivity !== null &&
      state.sensitivity !== 'routine' &&
      state.sensitivity !== 'sensitive') ||
    !Array.isArray(state.missingMandatory) ||
    !state.missingMandatory.every((field) => typeof field === 'string') ||
    (state.outcomeCode !== undefined &&
      state.outcomeCode !== 'processing-failed' &&
      state.outcomeCode !== 'refused' &&
      state.outcomeCode !== 'validation-failed')
  ) {
    throw new Error('Email draft activity returned an invalid state.');
  }
  const parsed: DurableEmailDraftState = {
    emailDraftId,
    missingMandatory: state.missingMandatory,
    ...(state.outcomeCode === undefined ? {} : { outcomeCode: state.outcomeCode }),
    sensitivity: state.sensitivity,
    status: state.status,
  };
  assertDurablePayload(parsed, 'emailDraftState');
  return parsed;
}

function parseApprovalInput(
  value: unknown,
  emailDraftId: string,
): ApprovalRoutingOrchestratorInput {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Email draft activity returned an invalid Approval request.');
  }
  const approval = value as Record<string, unknown>;
  if (
    Object.keys(approval).some(
      (key) =>
        ![
          'actor',
          'approvalId',
          'homeId',
          'requestedByUserId',
          'requiredRoles',
          'signaturesRequired',
          'subjectId',
          'subjectType',
          'tenantId',
        ].includes(key),
    ) ||
    approval.approvalId !== emailDraftId ||
    approval.subjectId !== emailDraftId ||
    approval.subjectType !== 'email_draft' ||
    typeof approval.homeId !== 'string' ||
    typeof approval.tenantId !== 'string' ||
    typeof approval.requestedByUserId !== 'string' ||
    !Array.isArray(approval.requiredRoles) ||
    !approval.requiredRoles.every((role) => role === 'manager' || role === 'safeguarding_lead') ||
    (approval.signaturesRequired !== 1 && approval.signaturesRequired !== 2) ||
    typeof approval.actor !== 'object' ||
    approval.actor === null
  ) {
    throw new Error('Email draft activity returned an invalid Approval request.');
  }
  const parsed = approval as unknown as ApprovalRoutingOrchestratorInput;
  assertDurablePayload(parsed, 'emailDraftApproval');
  return parsed;
}

function failedState(emailDraftId: string): DurableEmailDraftState {
  return {
    emailDraftId,
    missingMandatory: [],
    outcomeCode: 'processing-failed',
    sensitivity: null,
    status: 'failed',
  };
}

function isStatus(value: unknown): value is DurableEmailDraftState['status'] {
  return ['draft', 'needs_review', 'approved', 'rejected', 'sent_stub', 'failed'].includes(
    String(value),
  );
}
