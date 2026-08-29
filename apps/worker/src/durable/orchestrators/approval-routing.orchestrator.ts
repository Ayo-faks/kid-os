import type { ApprovalRole } from '@careos/contracts';
import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import {
  APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY,
  APPROVAL_DECISION_EVENT,
  APPROVAL_ORCHESTRATION_VERSION,
  type ApprovalDecisionEvent,
  type ApprovalRoutingOrchestratorInput,
  type ApplyApprovalDecisionCommandInput,
  CREATE_APPROVAL_REQUEST_ACTIVITY,
  type CreateApprovalRequestFromReferenceInput,
  type DurableApprovalSignature,
  type DurableApprovalState,
} from '../approval-routing.contracts.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

const APPROVAL_ACTIVITY_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 1_000,
  maxNumberOfAttempts: 5,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* approvalRoutingOrchestrator(
  context: OrchestrationContext,
  input: ApprovalRoutingOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableApprovalState, unknown> {
  assertDurableInstanceId(context.instanceId);
  assertDurablePayload(input, 'approvalRouting');

  const created = yield context.callActivity<
    CreateApprovalRequestFromReferenceInput,
    DurableApprovalState
  >(
    CREATE_APPROVAL_REQUEST_ACTIVITY,
    { ...input, workflowId: context.instanceId },
    { retry: APPROVAL_ACTIVITY_RETRY, version: APPROVAL_ORCHESTRATION_VERSION },
  );
  let state = parseApprovalState(created, input);
  context.setCustomStatus(state);

  while (state.status === 'pending') {
    const eventValue = yield context.waitForExternalEvent(APPROVAL_DECISION_EVENT);
    assertDurablePayload(eventValue, 'approvalDecisionEvent');
    const event = parseDecisionEvent(eventValue);
    const applied = yield context.callActivity<
      ApplyApprovalDecisionCommandInput,
      DurableApprovalState
    >(
      APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY,
      {
        approvalId: input.approvalId,
        commandId: event.commandId,
        homeId: input.homeId,
        tenantId: input.tenantId,
      },
      { retry: APPROVAL_ACTIVITY_RETRY, version: APPROVAL_ORCHESTRATION_VERSION },
    );
    state = parseApprovalState(applied, input);
    context.setCustomStatus(state);
  }

  return state;
}

// durabletask-js 0.3.0 declares TOrchestrator as a synchronous Generator while
// its executor recognizes AsyncGenerator. Keep the compatibility cast here.
export const ApprovalRoutingOrchestrator = approvalRoutingOrchestrator as unknown as TOrchestrator;

function parseDecisionEvent(value: unknown): ApprovalDecisionEvent {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !('commandId' in value) ||
    typeof value.commandId !== 'string' ||
    value.commandId.length === 0
  ) {
    throw new Error('Approval decision events must contain only a non-empty commandId.');
  }
  return { commandId: value.commandId };
}

function parseApprovalState(
  value: unknown,
  input: ApprovalRoutingOrchestratorInput,
): DurableApprovalState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Approval activity returned an invalid state.');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.approvalId !== input.approvalId ||
    candidate.subjectId !== input.subjectId ||
    candidate.subjectType !== input.subjectType ||
    !isApprovalStatus(candidate.status) ||
    !isApprovalRoleArray(candidate.requiredRoles) ||
    (candidate.signaturesRequired !== 1 && candidate.signaturesRequired !== 2) ||
    !Array.isArray(candidate.signatures) ||
    !candidate.signatures.every(isDurableApprovalSignature)
  ) {
    throw new Error('Approval activity returned an invalid state.');
  }
  const state: DurableApprovalState = {
    approvalId: input.approvalId,
    requiredRoles: candidate.requiredRoles,
    signatures: candidate.signatures,
    signaturesRequired: candidate.signaturesRequired,
    status: candidate.status,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
  };
  assertDurablePayload(state, 'approvalState');
  return state;
}

function isApprovalStatus(value: unknown): value is DurableApprovalState['status'] {
  return value === 'pending' || value === 'approved' || value === 'rejected';
}

function isApprovalRole(value: unknown): value is ApprovalRole {
  return value === 'manager' || value === 'safeguarding_lead';
}

function isApprovalRoleArray(value: unknown): value is ApprovalRole[] {
  return Array.isArray(value) && value.every(isApprovalRole);
}

function isDurableApprovalSignature(value: unknown): value is DurableApprovalSignature {
  if (typeof value !== 'object' || value === null) return false;
  const signature = value as Record<string, unknown>;
  return (
    typeof signature.userId === 'string' &&
    (isApprovalRole(signature.role) || signature.role === 'ops_admin') &&
    (signature.decision === 'approved' || signature.decision === 'rejected') &&
    Object.keys(signature).every((key) => ['decision', 'role', 'userId'].includes(key))
  );
}
