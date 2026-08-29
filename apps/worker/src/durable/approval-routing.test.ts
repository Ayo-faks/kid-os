import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY,
  APPROVAL_DECISION_EVENT,
  APPROVAL_ROUTING_ORCHESTRATOR,
  type ApprovalRoutingOrchestratorInput,
  approvalRoutingInstanceId,
  CREATE_APPROVAL_REQUEST_ACTIVITY,
  type DurableApprovalSignature,
  type DurableApprovalState,
} from './approval-routing.contracts.js';
import { ApprovalRoutingOrchestrator } from './orchestrators/approval-routing.orchestrator.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const approvalId = '33333333-3333-4333-8333-333333333333';
const requesterId = '44444444-4444-4444-8444-444444444444';
const managerId = '55555555-5555-4555-8555-555555555555';
const safeguardingId = '66666666-6666-4666-8666-666666666666';
const subjectId = '77777777-7777-4777-8777-777777777777';

const input: ApprovalRoutingOrchestratorInput = {
  actor: { correlationId: 'corr-approval', kind: 'user', userId: requesterId },
  approvalId,
  homeId,
  requestedByUserId: requesterId,
  requiredRoles: ['manager', 'safeguarding_lead'],
  signaturesRequired: 2,
  subjectId,
  subjectType: 'incident',
  tenantId,
};

const runningWorkers: TestOrchestrationWorker[] = [];
const runningClients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(runningWorkers.splice(0).map((worker) => worker.stop()));
  await Promise.all(runningClients.splice(0).map((client) => client.stop()));
});

describe('Durable Approval Routing proof of concept', () => {
  it('buffers early decisions and approves after two distinct role-covering signers', async () => {
    const runtime = approvalRuntime();
    const instanceId = approvalRoutingInstanceId(approvalId);
    await runtime.client.scheduleNewOrchestration(APPROVAL_ROUTING_ORCHESTRATOR, input, instanceId);
    await raise(runtime.client, instanceId, 'manager-approve');
    await raise(runtime.client, instanceId, 'safeguarding-approve');
    await runtime.worker.start();

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
    const output = parseOutput(state?.serializedOutput);
    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(output).toMatchObject({ signaturesRequired: 2, status: 'approved' });
    expect(output.signatures).toEqual([
      { decision: 'approved', role: 'manager', userId: managerId },
      { decision: 'approved', role: 'safeguarding_lead', userId: safeguardingId },
    ]);
    expect(JSON.parse(state?.serializedCustomStatus ?? '{}')).toEqual(output);
  });

  it('drains duplicate commands without counting the same user twice', async () => {
    const runtime = approvalRuntime();
    await runtime.worker.start();
    const instanceId = approvalRoutingInstanceId(approvalId);
    await runtime.client.scheduleNewOrchestration(APPROVAL_ROUTING_ORCHESTRATOR, input, instanceId);
    for (const commandId of ['manager-approve', 'manager-approve', 'safeguarding-approve']) {
      await raise(runtime.client, instanceId, commandId);
    }

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
    const output = parseOutput(state?.serializedOutput);
    expect(output.status).toBe('approved');
    expect(output.signatures).toHaveLength(2);
    expect(runtime.applyDecision).toHaveBeenCalledTimes(3);
  });

  it('applies an out-of-order veto immediately and ignores queued approvals', async () => {
    const runtime = approvalRuntime();
    const instanceId = approvalRoutingInstanceId(approvalId);
    await runtime.client.scheduleNewOrchestration(APPROVAL_ROUTING_ORCHESTRATOR, input, instanceId);
    await raise(runtime.client, instanceId, 'manager-reject');
    await raise(runtime.client, instanceId, 'safeguarding-approve');
    await runtime.worker.start();

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
    expect(parseOutput(state?.serializedOutput).status).toBe('rejected');
    expect(runtime.applyDecision).toHaveBeenCalledTimes(1);

    await raise(runtime.client, instanceId, 'late-manager-approve');
    const afterLateEvent = await runtime.client.getOrchestrationState(instanceId, true);
    expect(afterLateEvent?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(parseOutput(afterLateEvent?.serializedOutput).status).toBe('rejected');
    expect(runtime.applyDecision).toHaveBeenCalledTimes(1);
  });

  it('recovers a pending approval after the worker restarts', async () => {
    const backend = new InMemoryOrchestrationBackend();
    const activities = approvalActivities();
    const firstWorker = configuredWorker(backend, activities);
    const client = new TestOrchestrationClient(backend);
    runningWorkers.push(firstWorker);
    runningClients.push(client);
    await firstWorker.start();
    const instanceId = approvalRoutingInstanceId(approvalId);
    await client.scheduleNewOrchestration(APPROVAL_ROUTING_ORCHESTRATOR, input, instanceId);
    await raise(client, instanceId, 'manager-approve');
    await activities.managerApplied;
    await firstWorker.stop();

    const secondWorker = configuredWorker(backend, activities);
    runningWorkers.push(secondWorker);
    await secondWorker.start();
    await raise(client, instanceId, 'safeguarding-approve');

    const state = await client.waitForOrchestrationCompletion(instanceId, true, 5);
    expect(parseOutput(state?.serializedOutput).status).toBe('approved');
  });

  it('supports operational termination while waiting for a decision', async () => {
    const runtime = approvalRuntime();
    await runtime.worker.start();
    const instanceId = approvalRoutingInstanceId(approvalId);
    await runtime.client.scheduleNewOrchestration(APPROVAL_ROUTING_ORCHESTRATOR, input, instanceId);
    await runtime.client.waitForOrchestrationStart(instanceId, false, 5);
    await runtime.client.terminateOrchestration(instanceId, 'operator-cancelled');

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
    expect(state?.runtimeStatus).toBe(OrchestrationStatus.TERMINATED);
  });

  it('rejects decision events that contain free-text fields', async () => {
    const runtime = approvalRuntime();
    await runtime.worker.start();
    const instanceId = approvalRoutingInstanceId(approvalId);
    await runtime.client.scheduleNewOrchestration(APPROVAL_ROUTING_ORCHESTRATOR, input, instanceId);
    await runtime.client.raiseOrchestrationEvent(instanceId, APPROVAL_DECISION_EVENT, {
      commandId: 'manager-approve',
      reason: 'resident-specific narrative',
    });

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(runtime.applyDecision).not.toHaveBeenCalled();
  });
});

function approvalRuntime() {
  const backend = new InMemoryOrchestrationBackend();
  const activities = approvalActivities();
  const worker = configuredWorker(backend, activities);
  const client = new TestOrchestrationClient(backend);
  runningWorkers.push(worker);
  runningClients.push(client);
  return { ...activities, client, worker };
}

function configuredWorker(
  backend: InMemoryOrchestrationBackend,
  activities: ReturnType<typeof approvalActivities>,
): TestOrchestrationWorker {
  const worker = new TestOrchestrationWorker(backend);
  worker.addNamedOrchestrator(APPROVAL_ROUTING_ORCHESTRATOR, ApprovalRoutingOrchestrator);
  worker.addNamedActivity(CREATE_APPROVAL_REQUEST_ACTIVITY, activities.createApproval);
  worker.addNamedActivity(APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY, activities.applyDecision);
  return worker;
}

function approvalActivities() {
  let signatures: DurableApprovalSignature[] = [];
  let resolveManagerApplied: (() => void) | undefined;
  const managerApplied = new Promise<void>((resolve) => {
    resolveManagerApplied = resolve;
  });
  const createApproval = vi.fn(() => stateFor(signatures, 'pending'));
  const applyDecision = vi.fn((_context: unknown, value: unknown) => {
    const commandId = commandIdFrom(value);
    if (commandId === 'manager-approve' || commandId === 'late-manager-approve') {
      if (!signatures.some((signature) => signature.userId === managerId)) {
        signatures = [...signatures, { decision: 'approved', role: 'manager', userId: managerId }];
      }
      resolveManagerApplied?.();
    } else if (commandId === 'safeguarding-approve') {
      if (!signatures.some((signature) => signature.userId === safeguardingId)) {
        signatures = [
          ...signatures,
          { decision: 'approved', role: 'safeguarding_lead', userId: safeguardingId },
        ];
      }
    } else if (commandId === 'manager-reject') {
      signatures = [{ decision: 'rejected', role: 'manager', userId: managerId }];
    } else {
      throw new Error(`Unknown approval command ${commandId}.`);
    }
    const status = signatures.some((signature) => signature.decision === 'rejected')
      ? 'rejected'
      : signatures.length >= 2
        ? 'approved'
        : 'pending';
    return stateFor(signatures, status);
  });
  return { applyDecision, createApproval, managerApplied };
}

function stateFor(
  signatures: readonly DurableApprovalSignature[],
  status: DurableApprovalState['status'],
): DurableApprovalState {
  return {
    approvalId,
    requiredRoles: ['manager', 'safeguarding_lead'],
    signatures,
    signaturesRequired: 2,
    status,
    subjectId,
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

function parseOutput(serializedOutput: string | undefined): DurableApprovalState {
  return JSON.parse(serializedOutput ?? '{}') as DurableApprovalState;
}

function raise(
  client: TestOrchestrationClient,
  instanceId: string,
  commandId: string,
): Promise<void> {
  return client.raiseOrchestrationEvent(instanceId, APPROVAL_DECISION_EVENT, { commandId });
}
