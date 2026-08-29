import {
  OrchestrationStatus,
  VersionFailureStrategy,
  VersionMatchStrategy,
} from '@microsoft/durabletask-js';
import {
  createAzureManagedClient,
  createAzureManagedWorkerBuilder,
} from '@microsoft/durabletask-js-azuremanaged';
import { afterEach, describe, expect, it } from 'vitest';

import {
  APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY,
  APPROVAL_DECISION_EVENT,
  APPROVAL_ROUTING_ORCHESTRATOR,
  CREATE_APPROVAL_REQUEST_ACTIVITY,
  type DurableApprovalState,
  approvalRoutingInstanceId,
} from './approval-routing.contracts.js';
import { START_INCIDENT_FOLLOW_UP_ACTIVITY } from './incident-follow-up.contracts.js';
import {
  APPLY_INCIDENT_COMMAND_ACTIVITY,
  INCIDENT_COMMAND_EVENT,
  INCIDENT_ORCHESTRATION_VERSION,
  INCIDENT_REPORT_ORCHESTRATOR,
  INITIALIZE_INCIDENT_ACTIVITY,
  RECORD_INCIDENT_APPROVAL_ACTIVITY,
  incidentReportInstanceId,
} from './incident-report.contracts.js';
import { ApprovalRoutingOrchestrator } from './orchestrators/approval-routing.orchestrator.js';
import { IncidentReportOrchestrator } from './orchestrators/incident-report.orchestrator.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Incident Report emulator integration', () => {
  it('buffers submit, awaits the Approval child, and exports after human approval', async () => {
    const incidentId = uuidFromClock();
    const client = createAzureManagedClient(connectionString);
    let incidentStatus: 'draft' | 'awaiting_approval' | 'approved' | 'exported' = 'draft';
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: INCIDENT_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: INCIDENT_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(INCIDENT_REPORT_ORCHESTRATOR, IncidentReportOrchestrator)
      .addNamedOrchestrator(APPROVAL_ROUTING_ORCHESTRATOR, ApprovalRoutingOrchestrator)
      .addNamedActivity(INITIALIZE_INCIDENT_ACTIVITY, () => incidentState(incidentId, 1, 'draft'))
      .addNamedActivity(APPLY_INCIDENT_COMMAND_ACTIVITY, (_context, value) => {
        const commandId = commandIdFrom(value);
        if (commandId === 'submit-command') {
          incidentStatus = 'awaiting_approval';
          return {
            approval: approvalInput(incidentId),
            kind: 'await_approval',
            state: incidentState(incidentId, 2, incidentStatus),
          };
        }
        incidentStatus = 'exported';
        return {
          kind: 'state',
          state: {
            ...incidentState(incidentId, 4, incidentStatus),
            exportObjectKey: 'incidents/emulator-export.pdf',
          },
        };
      })
      .addNamedActivity(CREATE_APPROVAL_REQUEST_ACTIVITY, () =>
        approvalState(incidentId, 'pending'),
      )
      .addNamedActivity(APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY, () =>
        approvalState(incidentId, 'approved'),
      )
      .addNamedActivity(RECORD_INCIDENT_APPROVAL_ACTIVITY, () => {
        incidentStatus = 'approved';
        return { followUps: [], state: incidentState(incidentId, 3, incidentStatus) };
      })
      .addNamedActivity(START_INCIDENT_FOLLOW_UP_ACTIVITY, () => 'follow-up-not-required')
      .build();
    stoppables.push(worker, client);

    const instanceId = incidentReportInstanceId(incidentId);
    await client.scheduleNewOrchestration(INCIDENT_REPORT_ORCHESTRATOR, incidentInput(incidentId), {
      instanceId,
      version: INCIDENT_ORCHESTRATION_VERSION,
    });
    await client.raiseOrchestrationEvent(instanceId, INCIDENT_COMMAND_EVENT, {
      commandId: 'submit-command',
    });
    await worker.start();

    const approvalInstanceId = approvalRoutingInstanceId(incidentId);
    await waitForInstanceRegistration(client, approvalInstanceId);
    await client.raiseOrchestrationEvent(approvalInstanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'manager-approve',
    });
    await waitForCustomStatus(client, instanceId, 'approved');
    await client.raiseOrchestrationEvent(instanceId, INCIDENT_COMMAND_EVENT, {
      commandId: 'export-command',
    });

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toMatchObject({
      exportObjectKey: 'incidents/emulator-export.pdf',
      status: 'exported',
    });
  }, 90_000);
});

function incidentInput(incidentId: string) {
  return {
    actor: {
      correlationId: `emulator-incident-${incidentId}`,
      kind: 'user' as const,
      userId: '44444444-4444-4444-8444-444444444444',
    },
    authorUserId: '44444444-4444-4444-8444-444444444444',
    formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
    homeId: '22222222-2222-4222-8222-222222222222',
    incidentId,
    initialCommandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    residentId: '33333333-3333-4333-8333-333333333333',
    tenantId: '11111111-1111-4111-8111-111111111111',
  };
}

function approvalInput(incidentId: string) {
  return {
    actor: {
      correlationId: `emulator-submit-${incidentId}`,
      kind: 'user' as const,
      userId: '44444444-4444-4444-8444-444444444444',
    },
    approvalId: incidentId,
    homeId: '22222222-2222-4222-8222-222222222222',
    requestedByUserId: '44444444-4444-4444-8444-444444444444',
    requiredRoles: ['manager'] as const,
    signaturesRequired: 1 as const,
    subjectId: incidentId,
    subjectType: 'incident' as const,
    tenantId: '11111111-1111-4111-8111-111111111111',
  };
}

function approvalState(
  incidentId: string,
  status: DurableApprovalState['status'],
): DurableApprovalState {
  return {
    approvalId: incidentId,
    requiredRoles: ['manager'],
    signatures:
      status === 'approved'
        ? [
            {
              decision: 'approved',
              role: 'manager',
              userId: '66666666-6666-4666-8666-666666666666',
            },
          ]
        : [],
    signaturesRequired: 1,
    status,
    subjectId: incidentId,
    subjectType: 'incident',
  };
}

function incidentState(
  incidentId: string,
  currentVersion: number,
  status: 'draft' | 'awaiting_approval' | 'approved' | 'exported',
) {
  return { currentVersion, incidentId, missingMandatory: [], status };
}

function commandIdFrom(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('commandId' in value)) {
    throw new Error('Missing commandId.');
  }
  if (typeof value.commandId !== 'string') throw new Error('Invalid commandId.');
  return value.commandId;
}

async function waitForCustomStatus(
  client: ReturnType<typeof createAzureManagedClient>,
  instanceId: string,
  expectedStatus: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await client.getOrchestrationState(instanceId, true);
    if (state?.serializedCustomStatus !== undefined) {
      const status = JSON.parse(state.serializedCustomStatus) as { status?: string };
      if (status.status === expectedStatus) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Incident ${instanceId} did not reach ${expectedStatus}.`);
}

async function waitForInstanceRegistration(
  client: ReturnType<typeof createAzureManagedClient>,
  instanceId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await client.getOrchestrationState(instanceId, false)) !== undefined) return;
    } catch (error) {
      if (!isGrpcNotFound(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Orchestration ${instanceId} was not registered.`);
}

function isGrpcNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 5;
}

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `99999999-9999-4999-8999-${digits}`;
}
