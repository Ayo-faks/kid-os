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

import { RetentionSweepOrchestrator } from './orchestrators/retention.orchestrators.js';
import {
  FINALIZE_RETENTION_SWEEP_FAILURE_ACTIVITY,
  PROCESS_RETENTION_SWEEP_ACTIVITY,
  RETENTION_ORCHESTRATION_VERSION,
  RETENTION_SWEEP_ORCHESTRATOR,
  retentionSweepInstanceId,
} from './retention.contracts.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Retention emulator integration', () => {
  it('executes an aggregate-only sweep through the DTS emulator', async () => {
    const sweepId = uuidFromClock();
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: RETENTION_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: RETENTION_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(RETENTION_SWEEP_ORCHESTRATOR, RetentionSweepOrchestrator)
      .addNamedActivity(PROCESS_RETENTION_SWEEP_ACTIVITY, () => ({
        policiesApplied: 2,
        sweepId,
        totalAffected: 4,
        totalScanned: 5,
      }))
      .addNamedActivity(FINALIZE_RETENTION_SWEEP_FAILURE_ACTIVITY, () => undefined)
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = retentionSweepInstanceId(sweepId);
    await client.scheduleNewOrchestration(
      RETENTION_SWEEP_ORCHESTRATOR,
      {
        correlationId: `emulator-retention-${sweepId}`,
        nowIso: '2026-07-18T01:00:00.000Z',
        sweepId,
      },
      { instanceId, version: RETENTION_ORCHESTRATION_VERSION },
    );

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({
      policiesApplied: 2,
      sweepId,
      totalAffected: 4,
      totalScanned: 5,
    });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `96969696-9696-4696-8969-${digits}`;
}
