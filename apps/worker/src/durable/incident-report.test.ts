import type { IncidentFollowUpActionDescriptor } from '@careos/contracts';
import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY,
  APPROVAL_DECISION_EVENT,
  APPROVAL_ROUTING_ORCHESTRATOR,
  CREATE_APPROVAL_REQUEST_ACTIVITY,
  type DurableApprovalSignature,
  type DurableApprovalState,
  approvalRoutingInstanceId,
} from './approval-routing.contracts.js';
import { START_INCIDENT_FOLLOW_UP_ACTIVITY } from './incident-follow-up.contracts.js';
import {
  APPLY_INCIDENT_COMMAND_ACTIVITY,
  type ApplyIncidentCommandResult,
  type DurableIncidentState,
  INCIDENT_COMMAND_EVENT,
  INCIDENT_REPORT_ORCHESTRATOR,
  type IncidentReportOrchestratorInput,
  INITIALIZE_INCIDENT_ACTIVITY,
  RECORD_INCIDENT_APPROVAL_ACTIVITY,
  incidentReportInstanceId,
} from './incident-report.contracts.js';
import { ApprovalRoutingOrchestrator } from './orchestrators/approval-routing.orchestrator.js';
import { IncidentReportOrchestrator } from './orchestrators/incident-report.orchestrator.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const residentId = '33333333-3333-4333-8333-333333333333';
const authorUserId = '44444444-4444-4444-8444-444444444444';
const incidentId = '55555555-5555-4555-8555-555555555555';
const managerId = '66666666-6666-4666-8666-666666666666';

const input: IncidentReportOrchestratorInput = {
  actor: { correlationId: 'corr-incident', kind: 'user', userId: authorUserId },
  authorUserId,
  formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
  homeId,
  incidentId,
  initialCommandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  residentId,
  tenantId,
};

const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Incident Report proof of concept', () => {
  it('awaits Approval, persists terminal approval, and exports only after approval', async () => {
    const runtime = incidentRuntime('approved');
    await runtime.worker.start();
    const instanceId = incidentReportInstanceId(incidentId);
    await runtime.client.scheduleNewOrchestration(INCIDENT_REPORT_ORCHESTRATOR, input, instanceId);
    await raiseIncident(runtime.client, instanceId, 'submit-command');

    const approvalInstanceId = approvalRoutingInstanceId(incidentId);
    await runtime.client.waitForOrchestrationStart(approvalInstanceId, false, 5);
    await runtime.client.raiseOrchestrationEvent(approvalInstanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'manager-approve',
    });
    await runtime.approvalRecorded;
    await raiseIncident(runtime.client, instanceId, 'export-command');

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(parseIncidentOutput(state?.serializedOutput)).toEqual({
      currentVersion: 4,
      exportObjectKey: 'incidents/export.pdf',
      incidentId,
      missingMandatory: [],
      status: 'exported',
    });
  });

  it('persists an Approval veto as terminal and never exports', async () => {
    const runtime = incidentRuntime('rejected');
    await runtime.worker.start();
    const instanceId = incidentReportInstanceId(incidentId);
    await runtime.client.scheduleNewOrchestration(INCIDENT_REPORT_ORCHESTRATOR, input, instanceId);
    await raiseIncident(runtime.client, instanceId, 'submit-command');

    const approvalInstanceId = approvalRoutingInstanceId(incidentId);
    await runtime.client.waitForOrchestrationStart(approvalInstanceId, false, 5);
    await runtime.client.raiseOrchestrationEvent(approvalInstanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'manager-reject',
    });

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
    expect(parseIncidentOutput(state?.serializedOutput).status).toBe('rejected');
    expect(runtime.incidentCommands).toEqual(['submit-command']);
  });

  it('applies a draft update and remains available for later commands', async () => {
    const runtime = incidentRuntime('approved');
    await runtime.worker.start();
    const instanceId = incidentReportInstanceId(incidentId);
    await runtime.client.scheduleNewOrchestration(INCIDENT_REPORT_ORCHESTRATOR, input, instanceId);
    await raiseIncident(runtime.client, instanceId, 'update-command');

    const state = await waitForIncidentStatus(runtime.client, instanceId, 'draft');
    expect(JSON.parse(state.serializedCustomStatus ?? '{}')).toMatchObject({
      currentVersion: 2,
      status: 'draft',
    });
    expect(state.runtimeStatus).toBe(OrchestrationStatus.RUNNING);
    expect(runtime.incidentCommands).toEqual(['update-command']);
  });

  it('returns an invalid submission to awaiting fields without starting Approval', async () => {
    const runtime = incidentRuntime('approved');
    await runtime.worker.start();
    const instanceId = incidentReportInstanceId(incidentId);
    await runtime.client.scheduleNewOrchestration(INCIDENT_REPORT_ORCHESTRATOR, input, instanceId);
    await raiseIncident(runtime.client, instanceId, 'invalid-submit-command');

    const state = await waitForIncidentStatus(runtime.client, instanceId, 'awaiting_fields');
    expect(JSON.parse(state.serializedCustomStatus ?? '{}')).toMatchObject({
      currentVersion: 2,
      missingMandatory: ['residentId'],
      status: 'awaiting_fields',
    });
    expect(
      await runtime.client.getOrchestrationState(approvalRoutingInstanceId(incidentId), false),
    ).toBeUndefined();
  });

  it('starts persisted safeguarding follow-ups as ID-only detached roots', async () => {
    const action: IncidentFollowUpActionDescriptor = {
      actionId: '77777777-7777-4777-8777-777777777777',
      attempt: 1,
      kind: 'safeguarding_email',
      targetId: '88888888-8888-4888-8888-888888888888',
      workflowId: 'incident-follow-up-77777777-7777-4777-8777-777777777777-attempt-1',
    };
    const runtime = incidentRuntime('approved', [action]);
    await runtime.worker.start();
    const instanceId = incidentReportInstanceId(incidentId);
    await runtime.client.scheduleNewOrchestration(INCIDENT_REPORT_ORCHESTRATOR, input, instanceId);
    await raiseIncident(runtime.client, instanceId, 'submit-command');

    const approvalInstanceId = approvalRoutingInstanceId(incidentId);
    await runtime.client.waitForOrchestrationStart(approvalInstanceId, false, 5);
    await runtime.client.raiseOrchestrationEvent(approvalInstanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'manager-approve',
    });
    await runtime.followUpStarted;

    expect(runtime.startedFollowUps).toEqual([
      {
        ...action,
        correlationId: input.actor.correlationId,
        homeId,
        incidentId,
        requestedByUserId: managerId,
        tenantId,
      },
    ]);
    expect(JSON.stringify(runtime.startedFollowUps)).not.toContain('resident text');
  });

  it('rejects incident events carrying form data instead of a command id', async () => {
    const runtime = incidentRuntime('approved');
    await runtime.worker.start();
    const instanceId = incidentReportInstanceId(incidentId);
    await runtime.client.scheduleNewOrchestration(INCIDENT_REPORT_ORCHESTRATOR, input, instanceId);
    await runtime.client.raiseOrchestrationEvent(instanceId, INCIDENT_COMMAND_EVENT, {
      commandId: 'draft-command',
      formData: { narrative: 'resident text' },
    });

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });
});

function incidentRuntime(
  approvalOutcome: 'approved' | 'rejected',
  followUps: readonly IncidentFollowUpActionDescriptor[] = [],
) {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  const incidentCommands: string[] = [];
  const startedFollowUps: unknown[] = [];
  let resolveFollowUpStarted: (() => void) | undefined;
  const followUpStarted = new Promise<void>((resolve) => {
    resolveFollowUpStarted = resolve;
  });
  let resolveApprovalRecorded: (() => void) | undefined;
  const approvalRecorded = new Promise<void>((resolve) => {
    resolveApprovalRecorded = resolve;
  });
  let incidentState: DurableIncidentState = {
    currentVersion: 1,
    incidentId,
    missingMandatory: [],
    status: 'draft',
  };
  let approvalSignatures: DurableApprovalSignature[] = [];

  worker.addNamedOrchestrator(INCIDENT_REPORT_ORCHESTRATOR, IncidentReportOrchestrator);
  worker.addNamedOrchestrator(APPROVAL_ROUTING_ORCHESTRATOR, ApprovalRoutingOrchestrator);
  worker.addNamedActivity(INITIALIZE_INCIDENT_ACTIVITY, () => incidentState);
  worker.addNamedActivity(APPLY_INCIDENT_COMMAND_ACTIVITY, (_context, value) => {
    const commandId = readCommandId(value);
    incidentCommands.push(commandId);
    if (commandId === 'submit-command') {
      incidentState = { ...incidentState, currentVersion: 2, status: 'awaiting_approval' };
      return {
        approval: approvalInput(),
        kind: 'await_approval',
        state: incidentState,
      } satisfies ApplyIncidentCommandResult;
    }
    if (commandId === 'update-command') {
      incidentState = { ...incidentState, currentVersion: 2, status: 'draft' };
      return { kind: 'state', state: incidentState } satisfies ApplyIncidentCommandResult;
    }
    if (commandId === 'invalid-submit-command') {
      incidentState = {
        ...incidentState,
        currentVersion: 2,
        missingMandatory: ['residentId'],
        status: 'awaiting_fields',
      };
      return { kind: 'state', state: incidentState } satisfies ApplyIncidentCommandResult;
    }
    incidentState = {
      ...incidentState,
      currentVersion: 4,
      exportObjectKey: 'incidents/export.pdf',
      status: 'exported',
    };
    return { kind: 'state', state: incidentState } satisfies ApplyIncidentCommandResult;
  });
  worker.addNamedActivity(CREATE_APPROVAL_REQUEST_ACTIVITY, () => approvalState());
  worker.addNamedActivity(APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY, (_context, value) => {
    const commandId = readCommandId(value);
    approvalSignatures = [
      {
        decision: approvalOutcome,
        role: 'manager',
        userId: managerId,
      },
    ];
    if (commandId !== 'manager-approve' && commandId !== 'manager-reject') {
      throw new Error(`Unexpected approval command ${commandId}.`);
    }
    return approvalState(approvalOutcome);
  });
  worker.addNamedActivity(RECORD_INCIDENT_APPROVAL_ACTIVITY, (_context, value) => {
    const approval = readApproval(value);
    if (approval.status === 'pending') {
      throw new Error('Approval result must be terminal.');
    }
    incidentState = {
      ...incidentState,
      currentVersion: 3,
      status: approval.status,
    };
    resolveApprovalRecorded?.();
    return { followUps, state: incidentState };
  });
  worker.addNamedActivity(START_INCIDENT_FOLLOW_UP_ACTIVITY, (_context, value: unknown) => {
    startedFollowUps.push(value);
    resolveFollowUpStarted?.();
    return actionWorkflowId(value);
  });

  workers.push(worker);
  clients.push(client);
  return {
    approvalRecorded,
    client,
    followUpStarted,
    incidentCommands,
    startedFollowUps,
    worker,
  };

  function approvalState(status: DurableApprovalState['status'] = 'pending'): DurableApprovalState {
    return {
      approvalId: incidentId,
      requiredRoles: ['manager'],
      signatures: approvalSignatures,
      signaturesRequired: 1,
      status,
      subjectId: incidentId,
      subjectType: 'incident',
    };
  }
}

function actionWorkflowId(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('workflowId' in value)) {
    throw new Error('Missing follow-up workflowId.');
  }
  if (typeof value.workflowId !== 'string') throw new Error('Invalid follow-up workflowId.');
  return value.workflowId;
}

function approvalInput() {
  return {
    actor: { correlationId: 'corr-submit', kind: 'user' as const, userId: authorUserId },
    approvalId: incidentId,
    homeId,
    requestedByUserId: authorUserId,
    requiredRoles: ['manager'] as const,
    signaturesRequired: 1 as const,
    subjectId: incidentId,
    subjectType: 'incident' as const,
    tenantId,
  };
}

function readCommandId(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('commandId' in value)) {
    throw new Error('Missing commandId.');
  }
  if (typeof value.commandId !== 'string') throw new Error('Invalid commandId.');
  return value.commandId;
}

function readApproval(value: unknown): DurableApprovalState {
  if (typeof value !== 'object' || value === null || !('approval' in value)) {
    throw new Error('Missing approval result.');
  }
  return value.approval as DurableApprovalState;
}

function parseIncidentOutput(serialized: string | undefined): DurableIncidentState {
  return JSON.parse(serialized ?? '{}') as DurableIncidentState;
}

function raiseIncident(
  client: TestOrchestrationClient,
  instanceId: string,
  commandId: string,
): Promise<void> {
  return client.raiseOrchestrationEvent(instanceId, INCIDENT_COMMAND_EVENT, { commandId });
}

async function waitForIncidentStatus(
  client: TestOrchestrationClient,
  instanceId: string,
  expectedStatus: string,
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await client.getOrchestrationState(instanceId, true);
    if (state?.serializedCustomStatus !== undefined) {
      const status = JSON.parse(state.serializedCustomStatus) as { readonly status?: string };
      if (status.status === expectedStatus) return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Incident ${instanceId} did not reach ${expectedStatus}.`);
}
