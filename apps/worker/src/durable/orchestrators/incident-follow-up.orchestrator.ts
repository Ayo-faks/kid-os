import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import type { ApprovalRoutingOrchestratorInput } from '../approval-routing.contracts.js';
import {
  type DurableIncidentFollowUpState,
  FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY,
  type FinalizeIncidentFollowUpInput,
  INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION,
  INCIDENT_FOLLOW_UP_ORCHESTRATOR,
  type IncidentFollowUpOrchestratorInput,
  PROCESS_INCIDENT_FOLLOW_UP_ACTIVITY,
  type ProcessIncidentFollowUpResult,
  START_FOLLOW_UP_APPROVAL_ACTIVITY,
} from '../incident-follow-up.contracts.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

const FOLLOW_UP_RETRY = new RetryPolicy({
  firstRetryIntervalInMilliseconds: 1_000,
  maxNumberOfAttempts: 5,
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators, even when no direct await is needed.
async function* incidentFollowUpActionOrchestrator(
  context: OrchestrationContext,
  input: IncidentFollowUpOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurableIncidentFollowUpState, unknown> {
  assertDurableInstanceId(context.instanceId);
  assertDurablePayload(input, 'incidentFollowUp');

  try {
    const processedValue = yield context.callActivity<
      IncidentFollowUpOrchestratorInput,
      ProcessIncidentFollowUpResult
    >(PROCESS_INCIDENT_FOLLOW_UP_ACTIVITY, input, {
      retry: FOLLOW_UP_RETRY,
      version: INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION,
    });
    const processed = parseProcessedResult(processedValue);
    let status: DurableIncidentFollowUpState['status'];
    let failureCode: FinalizeIncidentFollowUpInput['failureCode'];
    if (processed.kind === 'await_approval') {
      yield context.callActivity<ApprovalRoutingOrchestratorInput, string>(
        START_FOLLOW_UP_APPROVAL_ACTIVITY,
        processed.approval,
        { retry: FOLLOW_UP_RETRY, version: INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION },
      );
      status = 'awaiting_approval';
    } else {
      status = processed.status;
      failureCode =
        processed.status === 'needs_configuration'
          ? 'safeguarding-contact-not-configured'
          : undefined;
    }

    yield context.callActivity<FinalizeIncidentFollowUpInput, void>(
      FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY,
      finalizeInput(input, status, failureCode),
      { retry: FOLLOW_UP_RETRY, version: INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION },
    );
    return { actionId: input.actionId, status, targetId: input.targetId };
  } catch {
    yield context.callActivity<FinalizeIncidentFollowUpInput, void>(
      FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY,
      finalizeInput(input, 'failed', 'incident-follow-up-processing-failed'),
      { retry: FOLLOW_UP_RETRY, version: INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION },
    );
    return { actionId: input.actionId, status: 'failed', targetId: input.targetId };
  }
}

export const IncidentFollowUpActionOrchestrator =
  incidentFollowUpActionOrchestrator as unknown as TOrchestrator;

export const INCIDENT_FOLLOW_UP_ORCHESTRATOR_NAME = INCIDENT_FOLLOW_UP_ORCHESTRATOR;

function parseProcessedResult(value: unknown): ProcessIncidentFollowUpResult {
  assertDurablePayload(value, 'incidentFollowUpResult');
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    throw new Error('Incident follow-up activity returned an invalid result.');
  }
  if (
    value.kind === 'terminal' &&
    'status' in value &&
    (value.status === 'completed' || value.status === 'needs_configuration')
  ) {
    return { kind: 'terminal', status: value.status };
  }
  if (value.kind === 'await_approval' && 'approval' in value) {
    return {
      approval: value.approval as ApprovalRoutingOrchestratorInput,
      kind: 'await_approval',
    };
  }
  throw new Error('Incident follow-up activity returned an invalid result.');
}

function finalizeInput(
  input: IncidentFollowUpOrchestratorInput,
  status: DurableIncidentFollowUpState['status'],
  failureCode?: FinalizeIncidentFollowUpInput['failureCode'],
): FinalizeIncidentFollowUpInput {
  return {
    actionId: input.actionId,
    correlationId: input.correlationId,
    ...(failureCode === undefined ? {} : { failureCode }),
    homeId: input.homeId,
    kind: input.kind,
    status,
    targetId: input.targetId,
    tenantId: input.tenantId,
  };
}
