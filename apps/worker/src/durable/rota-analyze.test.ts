import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import { RotaAnalyzeOrchestrator } from './orchestrators/rota-analyze.orchestrator.js';
import {
  FINALIZE_ROTA_ANALYZE_FAILURE_ACTIVITY,
  PROCESS_ROTA_ANALYZE_COMMAND_ACTIVITY,
  ROTA_ANALYZE_ORCHESTRATOR,
  type RotaAnalyzeOrchestratorInput,
  rotaAnalyzeInstanceId,
} from './rota-analyze.contracts.js';

const input: RotaAnalyzeOrchestratorInput = {
  actor: {
    correlationId: 'corr-rota-analyze',
    kind: 'user',
    userId: '55555555-5555-4555-8555-555555555555',
  },
  analysisId: '44444444-4444-4444-8444-444444444444',
  commandId: '66666666-6666-4666-8666-666666666666',
  homeId: '22222222-2222-4222-8222-222222222222',
  requestedByUserId: '55555555-5555-4555-8555-555555555555',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Rota Analyze orchestration', () => {
  it('completes with an analysis ID only', async () => {
    const runtime = analysisRuntime({ analysisId: input.analysisId, status: 'completed' });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      analysisId: input.analysisId,
      status: 'completed',
    });
  });

  it('fails truthfully with a closed outcome code', async () => {
    const runtime = analysisRuntime({
      analysisId: input.analysisId,
      outcomeCode: 'processing-failed',
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

  it('finalizes a result that attempts to include narration', async () => {
    const runtime = analysisRuntime({
      analysisId: input.analysisId,
      narration: 'private rota narration',
      status: 'completed',
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(runtime.finalizations).toEqual([
      expect.objectContaining({ analysisId: input.analysisId }),
    ]);
  });

  it('rejects scheduler input containing a proposal reason', async () => {
    const runtime = analysisRuntime({ analysisId: input.analysisId, status: 'completed' });
    await runtime.worker.start();
    const instanceId = rotaAnalyzeInstanceId(input.analysisId);
    await runtime.client.scheduleNewOrchestration(
      ROTA_ANALYZE_ORCHESTRATOR,
      { ...input, reason: 'private proposal reasoning' },
      instanceId,
    );

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });
});

function analysisRuntime(result: unknown) {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  const finalizations: unknown[] = [];
  worker.addNamedOrchestrator(ROTA_ANALYZE_ORCHESTRATOR, RotaAnalyzeOrchestrator);
  worker.addNamedActivity(PROCESS_ROTA_ANALYZE_COMMAND_ACTIVITY, () => result);
  worker.addNamedActivity(FINALIZE_ROTA_ANALYZE_FAILURE_ACTIVITY, (_context, value: unknown) => {
    finalizations.push(value);
  });
  workers.push(worker);
  clients.push(client);
  return { client, finalizations, worker };
}

async function run(runtime: ReturnType<typeof analysisRuntime>) {
  const instanceId = rotaAnalyzeInstanceId(input.analysisId);
  await runtime.client.scheduleNewOrchestration(ROTA_ANALYZE_ORCHESTRATOR, input, instanceId);
  return runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
}
