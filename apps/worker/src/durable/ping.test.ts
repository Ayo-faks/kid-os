import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import { PingOrchestrator } from './orchestrators/ping.orchestrator.js';
import {
  FINALIZE_PING_FAILURE_ACTIVITY,
  PING_ORCHESTRATOR,
  PROCESS_PING_COMMAND_ACTIVITY,
  pingInstanceId,
} from './ping.contracts.js';

const input = {
  commandId: '66666666-6666-4666-8666-666666666666',
  correlationId: 'corr-ping',
  pingId: '44444444-4444-4444-8444-444444444444',
};
const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Ping orchestration', () => {
  it('completes with operational status only', async () => {
    const runtime = testRuntime({ httpStatus: 200, pingId: input.pingId, status: 'healthy' });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      httpStatus: 200,
      pingId: input.pingId,
      status: 'healthy',
    });
  });

  it('finalizes activity output that attempts to include a message', async () => {
    const runtime = testRuntime({
      httpStatus: 200,
      message: 'private ping',
      pingId: input.pingId,
      status: 'healthy',
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(runtime.finalizations).toEqual([input]);
  });

  it('rejects scheduler input containing a message', async () => {
    const runtime = testRuntime({ httpStatus: 200, pingId: input.pingId, status: 'healthy' });
    await runtime.worker.start();
    const instanceId = pingInstanceId(input.pingId);
    await runtime.client.scheduleNewOrchestration(
      PING_ORCHESTRATOR,
      { ...input, message: 'private ping' },
      instanceId,
    );

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });
});

function testRuntime(result: unknown) {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  const finalizations: unknown[] = [];
  worker.addNamedOrchestrator(PING_ORCHESTRATOR, PingOrchestrator);
  worker.addNamedActivity(PROCESS_PING_COMMAND_ACTIVITY, () => result);
  worker.addNamedActivity(FINALIZE_PING_FAILURE_ACTIVITY, (_context, value) => {
    finalizations.push(value);
  });
  workers.push(worker);
  clients.push(client);
  return { client, finalizations, worker };
}

async function run(runtime: ReturnType<typeof testRuntime>) {
  const instanceId = pingInstanceId(input.pingId);
  await runtime.client.scheduleNewOrchestration(PING_ORCHESTRATOR, input, instanceId);
  return runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
}
