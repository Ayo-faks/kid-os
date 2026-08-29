import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import { RotaPublishOrchestrator } from './orchestrators/rota-publish.orchestrator.js';
import {
  FINALIZE_ROTA_PUBLISH_FAILURE_ACTIVITY,
  PROCESS_ROTA_PUBLISH_COMMAND_ACTIVITY,
  ROTA_PUBLISH_ORCHESTRATOR,
  type RotaPublishOrchestratorInput,
  rotaPublishInstanceId,
} from './rota-publish.contracts.js';

const input: RotaPublishOrchestratorInput = {
  actor: {
    correlationId: 'corr-rota-publish',
    kind: 'user',
    userId: '55555555-5555-4555-8555-555555555555',
  },
  commandId: '66666666-6666-4666-8666-666666666666',
  homeId: '22222222-2222-4222-8222-222222222222',
  publicationId: '44444444-4444-4444-8444-444444444444',
  publishedByUserId: '55555555-5555-4555-8555-555555555555',
  shiftIds: ['33333333-3333-4333-8333-333333333333'],
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Rota Publish orchestration', () => {
  it('completes with published assignment IDs', async () => {
    const runtime = rotaRuntime({
      publicationId: input.publicationId,
      publishedAssignmentIds: ['77777777-7777-4777-8777-777777777777'],
      status: 'published',
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      publicationId: input.publicationId,
      publishedAssignmentIds: ['77777777-7777-4777-8777-777777777777'],
      status: 'published',
    });
  });

  it('fails truthfully with a closed outcome code', async () => {
    const runtime = rotaRuntime({
      outcomeCode: 'processing-failed',
      publicationId: input.publicationId,
      publishedAssignmentIds: [],
      status: 'failed',
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(JSON.parse(state?.serializedCustomStatus ?? '{}')).toMatchObject({
      outcomeCode: 'processing-failed',
      status: 'failed',
    });
    expect(runtime.finalizations).toEqual([]);
  });

  it('finalizes a result that attempts to include the private note', async () => {
    const runtime = rotaRuntime({
      note: 'private manager note',
      publicationId: input.publicationId,
      publishedAssignmentIds: [],
      status: 'published',
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(runtime.finalizations).toEqual([
      expect.objectContaining({ publicationId: input.publicationId }),
    ]);
  });

  it('rejects scheduler input containing a note', async () => {
    const runtime = rotaRuntime({
      publicationId: input.publicationId,
      publishedAssignmentIds: [],
      status: 'published',
    });
    await runtime.worker.start();
    const instanceId = rotaPublishInstanceId(input.publicationId);
    await runtime.client.scheduleNewOrchestration(
      ROTA_PUBLISH_ORCHESTRATOR,
      { ...input, note: 'private manager note' },
      instanceId,
    );

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });
});

function rotaRuntime(result: unknown) {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  const finalizations: unknown[] = [];
  worker.addNamedOrchestrator(ROTA_PUBLISH_ORCHESTRATOR, RotaPublishOrchestrator);
  worker.addNamedActivity(PROCESS_ROTA_PUBLISH_COMMAND_ACTIVITY, () => result);
  worker.addNamedActivity(FINALIZE_ROTA_PUBLISH_FAILURE_ACTIVITY, (_context, value: unknown) => {
    finalizations.push(value);
  });
  workers.push(worker);
  clients.push(client);
  return { client, finalizations, worker };
}

async function run(runtime: ReturnType<typeof rotaRuntime>) {
  const instanceId = rotaPublishInstanceId(input.publicationId);
  await runtime.client.scheduleNewOrchestration(ROTA_PUBLISH_ORCHESTRATOR, input, instanceId);
  return runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
}
