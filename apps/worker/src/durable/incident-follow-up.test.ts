import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY,
  INCIDENT_FOLLOW_UP_ORCHESTRATOR,
  type IncidentFollowUpOrchestratorInput,
  PROCESS_INCIDENT_FOLLOW_UP_ACTIVITY,
  START_FOLLOW_UP_APPROVAL_ACTIVITY,
} from './incident-follow-up.contracts.js';
import { IncidentFollowUpActionOrchestrator } from './orchestrators/incident-follow-up.orchestrator.js';

const input: IncidentFollowUpOrchestratorInput = {
  actionId: '11111111-1111-4111-8111-111111111111',
  attempt: 1,
  correlationId: 'corr-follow-up',
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '33333333-3333-4333-8333-333333333333',
  kind: 'safeguarding_email',
  requestedByUserId: '44444444-4444-4444-8444-444444444444',
  targetId: '55555555-5555-4555-8555-555555555555',
  tenantId: '66666666-6666-4666-8666-666666666666',
};
const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Incident follow-up orchestration', () => {
  it('starts email Approval as a detached root and records awaiting approval', async () => {
    const runtime = followUpRuntime('await_approval');
    await runtime.worker.start();
    await runtime.client.scheduleNewOrchestration(
      INCIDENT_FOLLOW_UP_ORCHESTRATOR,
      input,
      'incident-follow-up-email',
    );

    const completed = await runtime.client.waitForOrchestrationCompletion(
      'incident-follow-up-email',
      true,
      5,
    );

    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({
      actionId: input.actionId,
      status: 'awaiting_approval',
      targetId: input.targetId,
    });
    expect(runtime.startedApprovals).toEqual([input.targetId]);
    expect(runtime.finalized).toEqual([
      expect.objectContaining({ actionId: input.actionId, status: 'awaiting_approval' }),
    ]);
  });

  it('finalizes a completed export without launching Approval', async () => {
    const runtime = followUpRuntime('completed');
    await runtime.worker.start();
    await runtime.client.scheduleNewOrchestration(
      INCIDENT_FOLLOW_UP_ORCHESTRATOR,
      { ...input, kind: 'export_bundle' },
      'incident-follow-up-export',
    );

    const completed = await runtime.client.waitForOrchestrationCompletion(
      'incident-follow-up-export',
      true,
      5,
    );

    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toMatchObject({
      status: 'completed',
    });
    expect(runtime.startedApprovals).toEqual([]);
    expect(runtime.finalized).toEqual([
      expect.objectContaining({ kind: 'export_bundle', status: 'completed' }),
    ]);
  });
});

function followUpRuntime(outcome: 'await_approval' | 'completed') {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  const startedApprovals: string[] = [];
  const finalized: unknown[] = [];

  worker.addNamedOrchestrator(INCIDENT_FOLLOW_UP_ORCHESTRATOR, IncidentFollowUpActionOrchestrator);
  worker.addNamedActivity(PROCESS_INCIDENT_FOLLOW_UP_ACTIVITY, () =>
    outcome === 'await_approval'
      ? {
          approval: {
            actor: { correlationId: input.correlationId, kind: 'system', userId: null },
            approvalId: input.targetId,
            homeId: input.homeId,
            requestedByUserId: input.requestedByUserId,
            requiredRoles: ['manager', 'safeguarding_lead'],
            signaturesRequired: 2,
            subjectId: input.targetId,
            subjectType: 'email_draft',
            tenantId: input.tenantId,
          },
          kind: 'await_approval',
        }
      : { kind: 'terminal', status: 'completed' },
  );
  worker.addNamedActivity(START_FOLLOW_UP_APPROVAL_ACTIVITY, (_context, value: unknown) => {
    if (typeof value !== 'object' || value === null || !('approvalId' in value)) {
      throw new Error('Missing Approval id.');
    }
    startedApprovals.push(String(value.approvalId));
    return `approval-${String(value.approvalId)}`;
  });
  worker.addNamedActivity(FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY, (_context, value: unknown) => {
    finalized.push(value);
  });

  workers.push(worker);
  clients.push(client);
  return { client, finalized, startedApprovals, worker };
}
