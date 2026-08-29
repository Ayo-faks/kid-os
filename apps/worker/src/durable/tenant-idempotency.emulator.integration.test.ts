import { setTimeout as delay } from 'node:timers/promises';

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

type MutableApprovalState = Omit<DurableApprovalState, 'signatures' | 'status'> & {
  signatures: DurableApprovalSignature[];
  status: DurableApprovalState['status'];
};

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable tenant and idempotency integration', () => {
  it('produces one approval outcome across a duplicate start and duplicate event', async () => {
    const approvalId = uuidFromClock();
    const input = approvalInput(approvalId);
    const state = approvalState(approvalId);
    const appliedCommands: string[] = [];
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: APPROVAL_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: APPROVAL_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(APPROVAL_ROUTING_ORCHESTRATOR, ApprovalRoutingOrchestrator)
      .addNamedActivity(CREATE_APPROVAL_REQUEST_ACTIVITY, () => cloneState(state))
      .addNamedActivity(APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY, (_context, value) => {
        const commandId = commandIdFrom(value);
        appliedCommands.push(commandId);
        if (commandId === 'manager-command' && !hasRole(state.signatures, 'manager')) {
          state.signatures.push({
            decision: 'approved',
            role: 'manager',
            userId: input.requestedByUserId,
          });
        }
        if (
          commandId === 'safeguarding-command' &&
          !hasRole(state.signatures, 'safeguarding_lead')
        ) {
          state.signatures.push({
            decision: 'approved',
            role: 'safeguarding_lead',
            userId: '66666666-6666-4666-8666-666666666666',
          });
        }
        if (state.signatures.length === 2) state.status = 'approved';
        return cloneState(state);
      })
      .build();
    stoppables.push(client, worker);
    await worker.start();

    const instanceId = approvalRoutingInstanceId(approvalId);
    await client.scheduleNewOrchestration(APPROVAL_ROUTING_ORCHESTRATOR, input, {
      instanceId,
      version: APPROVAL_ORCHESTRATION_VERSION,
    });
    await client.waitForOrchestrationStart(instanceId, false, 30);
    await client
      .scheduleNewOrchestration(APPROVAL_ROUTING_ORCHESTRATOR, input, {
        instanceId,
        version: APPROVAL_ORCHESTRATION_VERSION,
      })
      .catch(() => undefined);

    await client.raiseOrchestrationEvent(instanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'manager-command',
    });
    await waitUntil(() => appliedCommands.length === 1);
    await client.raiseOrchestrationEvent(instanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'manager-command',
    });
    await waitUntil(() => appliedCommands.length === 2);
    expect(state.signatures).toHaveLength(1);
    await client.raiseOrchestrationEvent(instanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'safeguarding-command',
    });

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toMatchObject({
      signatures: [
        { role: 'manager', userId: input.requestedByUserId },
        {
          role: 'safeguarding_lead',
          userId: '66666666-6666-4666-8666-666666666666',
        },
      ],
      status: 'approved',
    });
    expect(appliedCommands).toEqual(['manager-command', 'manager-command', 'safeguarding-command']);
  }, 90_000);
});

function approvalInput(approvalId: string): ApprovalRoutingOrchestratorInput {
  return {
    actor: {
      correlationId: `tenant-idempotency-${approvalId}`,
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

function approvalState(approvalId: string): MutableApprovalState {
  return {
    approvalId,
    requiredRoles: ['manager', 'safeguarding_lead'],
    signatures: [],
    signaturesRequired: 2,
    status: 'pending',
    subjectId: '77777777-7777-4777-8777-777777777777',
    subjectType: 'incident',
  };
}

function cloneState(state: MutableApprovalState): DurableApprovalState {
  return { ...state, signatures: [...state.signatures] };
}

function commandIdFrom(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('commandId' in value)) {
    throw new Error('Missing commandId.');
  }
  if (typeof value.commandId !== 'string') throw new Error('Invalid commandId.');
  return value.commandId;
}

function hasRole(signatures: readonly DurableApprovalSignature[], role: string): boolean {
  return signatures.some((signature) => signature.role === role);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error('Durable approval activity did not observe the expected command.');
}

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `99999999-9999-4999-8999-${digits}`;
}
