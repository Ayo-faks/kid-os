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
  APPROVAL_ORCHESTRATION_VERSION,
  APPROVAL_ROUTING_ORCHESTRATOR,
  type ApprovalRoutingOrchestratorInput,
  approvalRoutingInstanceId,
  CREATE_APPROVAL_REQUEST_ACTIVITY,
  type DurableApprovalSignature,
  type DurableApprovalState,
} from './approval-routing.contracts.js';
import { ApprovalRoutingOrchestrator } from './orchestrators/approval-routing.orchestrator.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Approval Routing emulator integration', () => {
  it('buffers early external events, completes dual sign-off, and drops a late event', async () => {
    const approvalId = uuidFromClock();
    const input = approvalInput(approvalId);
    const state = approvalState(approvalId, []);
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: APPROVAL_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: APPROVAL_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(APPROVAL_ROUTING_ORCHESTRATOR, ApprovalRoutingOrchestrator)
      .addNamedActivity(CREATE_APPROVAL_REQUEST_ACTIVITY, () => state)
      .addNamedActivity(APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY, (_context, value) => {
        const commandId = commandIdFrom(value);
        if (commandId === 'manager-approve') {
          state.signatures = [
            { decision: 'approved', role: 'manager', userId: input.requestedByUserId },
          ];
          return { ...state, signatures: [...state.signatures] };
        }
        state.signatures = [
          ...state.signatures,
          {
            decision: 'approved',
            role: 'safeguarding_lead',
            userId: '66666666-6666-4666-8666-666666666666',
          },
        ];
        return { ...state, signatures: [...state.signatures], status: 'approved' };
      })
      .build();
    stoppables.push(worker, client);

    const instanceId = approvalRoutingInstanceId(approvalId);
    await client.scheduleNewOrchestration(APPROVAL_ROUTING_ORCHESTRATOR, input, {
      instanceId,
      version: APPROVAL_ORCHESTRATION_VERSION,
    });
    await client.raiseOrchestrationEvent(instanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'manager-approve',
    });
    await client.raiseOrchestrationEvent(instanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'safeguarding-approve',
    });
    await worker.start();

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toMatchObject({
      signaturesRequired: 2,
      status: 'approved',
    });

    await client.raiseOrchestrationEvent(instanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'late-approval',
    });
    const afterLateEvent = await client.getOrchestrationState(instanceId, true);
    expect(afterLateEvent?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
  }, 60_000);
});

function approvalInput(approvalId: string): ApprovalRoutingOrchestratorInput {
  return {
    actor: {
      correlationId: `emulator-approval-${approvalId}`,
      kind: 'user',
      userId: '55555555-5555-4555-8555-555555555555',
    },
    approvalId,
    homeId: '22222222-2222-4222-8222-222222222222',
    requestedByUserId: '55555555-5555-4555-8555-555555555555',
    requiredRoles: ['manager', 'safeguarding_lead'],
    signaturesRequired: 2,
    subjectId: '77777777-7777-4777-8777-777777777777',
    subjectType: 'incident',
    tenantId: '11111111-1111-4111-8111-111111111111',
  };
}

function approvalState(
  approvalId: string,
  signatures: DurableApprovalSignature[],
): DurableApprovalState & { signatures: DurableApprovalSignature[] } {
  return {
    approvalId,
    requiredRoles: ['manager', 'safeguarding_lead'],
    signatures,
    signaturesRequired: 2,
    status: 'pending',
    subjectId: '77777777-7777-4777-8777-777777777777',
    subjectType: 'incident',
  };
}

function commandIdFrom(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('commandId' in value)) {
    throw new Error('Missing commandId.');
  }
  if (typeof value.commandId !== 'string') throw new Error('Invalid commandId.');
  return value.commandId;
}

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `88888888-8888-4888-8888-${digits}`;
}
