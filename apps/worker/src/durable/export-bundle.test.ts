import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PROCESS_EXPORT_BUNDLE_ACTIVITY,
  SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR,
  type SeriousIncidentExportOrchestratorInput,
  exportBundleInstanceId,
} from './export-bundle.contracts.js';
import { SeriousIncidentExportOrchestrator } from './orchestrators/export-bundle.orchestrator.js';

const input: SeriousIncidentExportOrchestratorInput = {
  actor: {
    correlationId: 'corr-export',
    kind: 'user',
    userId: '55555555-5555-4555-8555-555555555555',
  },
  bundleId: '44444444-4444-4444-8444-444444444444',
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Serious Incident Export orchestration', () => {
  it('completes with an ID-only ready result', async () => {
    const runtime = exportRuntime({ bundleId: input.bundleId, status: 'ready' });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      bundleId: input.bundleId,
      status: 'ready',
    });
    expect(state?.serializedCustomStatus).toBe(state?.serializedOutput);
  });

  it('completes truthfully when bundle composition fails', async () => {
    const runtime = exportRuntime({
      bundleId: input.bundleId,
      outcomeCode: 'bundle-build-failed',
      status: 'failed',
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      bundleId: input.bundleId,
      outcomeCode: 'bundle-build-failed',
      status: 'failed',
    });
  });

  it('rejects an activity result containing signed bundle metadata', async () => {
    const runtime = exportRuntime({
      bundleId: input.bundleId,
      objectKey: 'tenants/t/incidents/i/bundles/b.zip',
      signature: 'private-signature',
      status: 'ready',
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });
});

function exportRuntime(result: unknown) {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  worker.addNamedOrchestrator(
    SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR,
    SeriousIncidentExportOrchestrator,
  );
  worker.addNamedActivity(PROCESS_EXPORT_BUNDLE_ACTIVITY, () => result);
  workers.push(worker);
  clients.push(client);
  return { client, worker };
}

async function run(runtime: ReturnType<typeof exportRuntime>) {
  const instanceId = exportBundleInstanceId(input.bundleId);
  await runtime.client.scheduleNewOrchestration(
    SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR,
    input,
    instanceId,
  );
  return runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
}
