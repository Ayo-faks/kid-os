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

import { RotaAnalyzeOrchestrator } from './orchestrators/rota-analyze.orchestrator.js';
import {
  FINALIZE_ROTA_ANALYZE_FAILURE_ACTIVITY,
  PROCESS_ROTA_ANALYZE_COMMAND_ACTIVITY,
  ROTA_ANALYZE_ORCHESTRATION_VERSION,
  ROTA_ANALYZE_ORCHESTRATOR,
  rotaAnalyzeInstanceId,
} from './rota-analyze.contracts.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Rota Analyze emulator integration', () => {
  it('executes an ID-only analysis through the DTS emulator', async () => {
    const analysisId = uuidFromClock();
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: ROTA_ANALYZE_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: ROTA_ANALYZE_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(ROTA_ANALYZE_ORCHESTRATOR, RotaAnalyzeOrchestrator)
      .addNamedActivity(PROCESS_ROTA_ANALYZE_COMMAND_ACTIVITY, () => ({
        analysisId,
        status: 'completed',
      }))
      .addNamedActivity(FINALIZE_ROTA_ANALYZE_FAILURE_ACTIVITY, () => undefined)
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = rotaAnalyzeInstanceId(analysisId);
    await client.scheduleNewOrchestration(
      ROTA_ANALYZE_ORCHESTRATOR,
      {
        actor: {
          correlationId: `emulator-rota-analyze-${analysisId}`,
          kind: 'user',
          userId: '55555555-5555-4555-8555-555555555555',
        },
        analysisId,
        commandId: '66666666-6666-4666-8666-666666666666',
        homeId: '22222222-2222-4222-8222-222222222222',
        requestedByUserId: '55555555-5555-4555-8555-555555555555',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      { instanceId, version: ROTA_ANALYZE_ORCHESTRATION_VERSION },
    );

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({
      analysisId,
      status: 'completed',
    });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `95959595-9595-4595-8959-${digits}`;
}
