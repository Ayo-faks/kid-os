import type { IncidentStatus } from '@careos/contracts';
import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import {
  APPROVAL_ORCHESTRATION_VERSION,
  APPROVAL_ROUTING_ORCHESTRATOR,
  type ApprovalRoutingOrchestratorInput,
  type DurableApprovalState,
  approvalRoutingInstanceId,
} from '../approval-routing.contracts.js';
import {
  followUpInputFromDescriptor,
  START_INCIDENT_FOLLOW_UP_ACTIVITY,
  type StartIncidentFollowUpInput,
} from '../incident-follow-up.contracts.js';
import {
  APPLY_INCIDENT_COMMAND_ACTIVITY,
  type ApplyIncidentCommandInput,
  type ApplyIncidentCommandResult,
  type DurableIncidentState,
  INCIDENT_COMMAND_EVENT,
  INCIDENT_ORCHESTRATION_VERSION,
  type IncidentCommandEvent,
  INCIDENT_REPORT_ORCHESTRATOR,
  type IncidentReportOrchestratorInput,
  INITIALIZE_INCIDENT_ACTIVITY,
  RECORD_INCIDENT_APPROVAL_ACTIVITY,
  type RecordIncidentApprovalResultInput,
  type RecordIncidentApprovalResultResult,
} from '../incident-report.contracts.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

const INCIDENT_ACTIVITY_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 1_000,
  maxNumberOfAttempts: 5,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* incidentReportOrchestrator(
  context: OrchestrationContext,
  input: IncidentReportOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableIncidentState, unknown> {
  assertDurableInstanceId(context.instanceId);
  assertDurablePayload(input, 'incidentReport');

  const initialized = yield context.callActivity<
    IncidentReportOrchestratorInput,
    DurableIncidentState
  >(INITIALIZE_INCIDENT_ACTIVITY, input, {
    retry: INCIDENT_ACTIVITY_RETRY,
    version: INCIDENT_ORCHESTRATION_VERSION,
  });
  let state = parseIncidentState(initialized, input.incidentId);
  context.setCustomStatus(state);

  while (!isIncidentTerminal(state.status)) {
    const eventValue = yield context.waitForExternalEvent(INCIDENT_COMMAND_EVENT);
    assertDurablePayload(eventValue, 'incidentCommandEvent');
    const event = parseCommandEvent(eventValue);
    const applied = yield context.callActivity<
      ApplyIncidentCommandInput,
      ApplyIncidentCommandResult
    >(
      APPLY_INCIDENT_COMMAND_ACTIVITY,
      {
        commandId: event.commandId,
        currentVersion: state.currentVersion,
        homeId: input.homeId,
        incidentId: input.incidentId,
        status: state.status,
        tenantId: input.tenantId,
      },
      { retry: INCIDENT_ACTIVITY_RETRY, version: INCIDENT_ORCHESTRATION_VERSION },
    );
    const commandResult = parseCommandResult(applied, input.incidentId);
    state = commandResult.state;
    context.setCustomStatus(state);

    if (commandResult.kind === 'await_approval') {
      assertDurablePayload(commandResult.approval, 'incidentApproval');
      const approvalValue = yield context.callSubOrchestrator(
        APPROVAL_ROUTING_ORCHESTRATOR,
        commandResult.approval,
        {
          instanceId: approvalRoutingInstanceId(commandResult.approval.approvalId),
          version: APPROVAL_ORCHESTRATION_VERSION,
        },
      );
      const approval = parseApprovalState(approvalValue, commandResult.approval.approvalId);
      const recorded = yield context.callActivity<
        RecordIncidentApprovalResultInput,
        RecordIncidentApprovalResultResult
      >(
        RECORD_INCIDENT_APPROVAL_ACTIVITY,
        {
          approval,
          correlationId: input.actor.correlationId,
          homeId: input.homeId,
          incidentId: input.incidentId,
          tenantId: input.tenantId,
        },
        { retry: INCIDENT_ACTIVITY_RETRY, version: INCIDENT_ORCHESTRATION_VERSION },
      );
      const approvalResult = parseRecordedApprovalResult(recorded, input.incidentId);
      state = approvalResult.state;
      context.setCustomStatus(state);
      const terminalSigner = approval.signatures.at(-1)?.userId;
      if (state.status === 'approved' && terminalSigner === undefined) {
        throw new Error('Approved Incident follow-ups require a terminal human signer.');
      }
      for (const followUp of approvalResult.followUps) {
        yield context.callActivity<StartIncidentFollowUpInput, string>(
          START_INCIDENT_FOLLOW_UP_ACTIVITY,
          followUpInputFromDescriptor(followUp, {
            correlationId: input.actor.correlationId,
            homeId: input.homeId,
            incidentId: input.incidentId,
            requestedByUserId: terminalSigner ?? input.authorUserId,
            tenantId: input.tenantId,
          }),
          { retry: INCIDENT_ACTIVITY_RETRY, version: INCIDENT_ORCHESTRATION_VERSION },
        );
      }
    }
  }

  return state;
}

function parseRecordedApprovalResult(
  value: unknown,
  incidentId: string,
): RecordIncidentApprovalResultResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('state' in value) ||
    !('followUps' in value) ||
    !Array.isArray(value.followUps)
  ) {
    throw new Error('Incident approval activity returned an invalid result.');
  }
  assertDurablePayload(value.followUps, 'incidentFollowUps');
  return {
    followUps: value.followUps.map((followUp) => parseFollowUpDescriptor(followUp)),
    state: parseIncidentState(value.state, incidentId),
  };
}

function parseFollowUpDescriptor(
  value: unknown,
): RecordIncidentApprovalResultResult['followUps'][number] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Incident approval activity returned an invalid follow-up descriptor.');
  }
  const descriptor = value as Record<string, unknown>;
  if (
    Object.keys(descriptor).some(
      (key) => !['actionId', 'attempt', 'kind', 'targetId', 'workflowId'].includes(key),
    ) ||
    typeof descriptor.actionId !== 'string' ||
    typeof descriptor.attempt !== 'number' ||
    (descriptor.kind !== 'safeguarding_email' && descriptor.kind !== 'export_bundle') ||
    typeof descriptor.targetId !== 'string' ||
    typeof descriptor.workflowId !== 'string'
  ) {
    throw new Error('Incident approval activity returned an invalid follow-up descriptor.');
  }
  return {
    actionId: descriptor.actionId,
    attempt: descriptor.attempt,
    kind: descriptor.kind,
    targetId: descriptor.targetId,
    workflowId: descriptor.workflowId,
  };
}

export const IncidentReportOrchestrator = incidentReportOrchestrator as unknown as TOrchestrator;

export const INCIDENT_REPORT_ORCHESTRATOR_NAME = INCIDENT_REPORT_ORCHESTRATOR;

function parseCommandEvent(value: unknown): IncidentCommandEvent {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== 1 ||
    !('commandId' in value) ||
    typeof value.commandId !== 'string' ||
    value.commandId.length === 0
  ) {
    throw new Error('Incident command events must contain only a non-empty commandId.');
  }
  return { commandId: value.commandId };
}

function parseCommandResult(value: unknown, incidentId: string): ApplyIncidentCommandResult {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('state' in value)) {
    throw new Error('Incident command activity returned an invalid result.');
  }
  const state = parseIncidentState(value.state, incidentId);
  if (value.kind === 'state') return { kind: 'state', state };
  if (value.kind !== 'await_approval' || !('approval' in value)) {
    throw new Error('Incident command activity returned an invalid result.');
  }
  return {
    approval: parseApprovalInput(value.approval, incidentId),
    kind: 'await_approval',
    state,
  };
}

function parseApprovalInput(value: unknown, incidentId: string): ApprovalRoutingOrchestratorInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('approvalId' in value) ||
    value.approvalId !== incidentId ||
    !('subjectId' in value) ||
    value.subjectId !== incidentId ||
    !('subjectType' in value) ||
    value.subjectType !== 'incident' ||
    !('tenantId' in value) ||
    typeof value.tenantId !== 'string' ||
    !('homeId' in value) ||
    typeof value.homeId !== 'string' ||
    !('requestedByUserId' in value) ||
    typeof value.requestedByUserId !== 'string' ||
    !('requiredRoles' in value) ||
    !Array.isArray(value.requiredRoles) ||
    !value.requiredRoles.every((role) => role === 'manager' || role === 'safeguarding_lead') ||
    !('signaturesRequired' in value) ||
    (value.signaturesRequired !== 1 && value.signaturesRequired !== 2) ||
    !('actor' in value) ||
    typeof value.actor !== 'object' ||
    value.actor === null
  ) {
    throw new Error('Incident command activity returned an invalid approval request.');
  }
  return value as ApprovalRoutingOrchestratorInput;
}

function parseIncidentState(value: unknown, incidentId: string): DurableIncidentState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Incident activity returned an invalid state.');
  }
  const state = value as Record<string, unknown>;
  if (
    state.incidentId !== incidentId ||
    typeof state.currentVersion !== 'number' ||
    !isIncidentStatus(state.status) ||
    !Array.isArray(state.missingMandatory) ||
    !state.missingMandatory.every((field) => typeof field === 'string') ||
    (state.exportObjectKey !== undefined && typeof state.exportObjectKey !== 'string')
  ) {
    throw new Error('Incident activity returned an invalid state.');
  }
  const parsed: DurableIncidentState = {
    currentVersion: state.currentVersion,
    ...(typeof state.exportObjectKey === 'string'
      ? { exportObjectKey: state.exportObjectKey }
      : {}),
    incidentId,
    missingMandatory: state.missingMandatory,
    status: state.status,
  };
  assertDurablePayload(parsed, 'incidentState');
  return parsed;
}

function parseApprovalState(value: unknown, approvalId: string): DurableApprovalState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('approvalId' in value) ||
    value.approvalId !== approvalId ||
    !('status' in value) ||
    (value.status !== 'approved' && value.status !== 'rejected')
  ) {
    throw new Error('Approval sub-orchestration completed without a terminal decision.');
  }
  return value as DurableApprovalState;
}

function isIncidentTerminal(status: IncidentStatus): boolean {
  return status === 'exported' || status === 'rejected';
}

function isIncidentStatus(value: unknown): value is IncidentStatus {
  return [
    'draft',
    'awaiting_fields',
    'awaiting_approval',
    'approved',
    'exported',
    'rejected',
  ].includes(String(value));
}
