import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FINALIZE_HANDOVER_FAILURE_ACTIVITY,
  HANDOVER_ORCHESTRATOR,
  type HandoverOrchestratorInput,
  PROCESS_HANDOVER_COMMAND_ACTIVITY,
  handoverInstanceId,
} from './handover.contracts.js';
import { HandoverOrchestrator } from './orchestrators/handover.orchestrator.js';

const input: HandoverOrchestratorInput = {
  actor: {
    correlationId: 'corr-handover',
    kind: 'user',
    userId: '55555555-5555-4555-8555-555555555555',
  },
  authorUserId: '55555555-5555-4555-8555-555555555555',
  commandId: '66666666-6666-4666-8666-666666666666',
  handoverId: '44444444-4444-4444-8444-444444444444',
  homeId: '22222222-2222-4222-8222-222222222222',
  shiftId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Handover orchestration', () => {
  it('completes with task IDs and no narrative', async () => {
    const runtime = handoverRuntime({
      handoverId: input.handoverId,
      missingMandatory: [],
      status: 'completed',
      taskIds: ['77777777-7777-4777-8777-777777777777'],
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      handoverId: input.handoverId,
      missingMandatory: [],
      status: 'completed',
      taskIds: ['77777777-7777-4777-8777-777777777777'],
    });
  });

  it('fails truthfully with sanitized validation status', async () => {
    const runtime = handoverRuntime({
      handoverId: input.handoverId,
      missingMandatory: ['endedAt'],
      outcomeCode: 'validation-failed',
      status: 'failed',
      taskIds: [],
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(JSON.parse(state?.serializedCustomStatus ?? '{}')).toMatchObject({
      missingMandatory: ['endedAt'],
      outcomeCode: 'validation-failed',
      status: 'failed',
    });
    expect(runtime.finalizations).toEqual([]);
  });

  it('finalizes a malformed activity result before failing generically', async () => {
    const runtime = handoverRuntime({
      freeText: 'private handover narrative',
      handoverId: input.handoverId,
      missingMandatory: [],
      status: 'completed',
      taskIds: [],
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(runtime.finalizations).toEqual([
      expect.objectContaining({
        handoverId: input.handoverId,
        outcomeCode: 'processing-failed',
      }),
    ]);
  });

  it('rejects scheduler input containing handover prose', async () => {
    const runtime = handoverRuntime({
      handoverId: input.handoverId,
      missingMandatory: [],
      status: 'completed',
      taskIds: [],
    });
    await runtime.worker.start();
    const instanceId = handoverInstanceId(input.handoverId);
    await runtime.client.scheduleNewOrchestration(
      HANDOVER_ORCHESTRATOR,
      { ...input, freeText: 'private handover narrative' },
      instanceId,
    );

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });
});

function handoverRuntime(result: unknown) {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  const finalizations: unknown[] = [];
  worker.addNamedOrchestrator(HANDOVER_ORCHESTRATOR, HandoverOrchestrator);
  worker.addNamedActivity(PROCESS_HANDOVER_COMMAND_ACTIVITY, () => result);
  worker.addNamedActivity(FINALIZE_HANDOVER_FAILURE_ACTIVITY, (_context, value: unknown) => {
    finalizations.push(value);
  });
  workers.push(worker);
  clients.push(client);
  return { client, finalizations, worker };
}

async function run(runtime: ReturnType<typeof handoverRuntime>) {
  const instanceId = handoverInstanceId(input.handoverId);
  await runtime.client.scheduleNewOrchestration(HANDOVER_ORCHESTRATOR, input, instanceId);
  return runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
}
