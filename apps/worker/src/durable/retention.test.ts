import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RetentionScheduleOrchestrator,
  RetentionSweepOrchestrator,
} from './orchestrators/retention.orchestrators.js';
import {
  CALCULATE_NEXT_RETENTION_FIRE_ACTIVITY,
  FINALIZE_RETENTION_SWEEP_FAILURE_ACTIVITY,
  PROCESS_RETENTION_SWEEP_ACTIVITY,
  RETENTION_SCHEDULE_ORCHESTRATOR,
  RETENTION_SWEEP_ORCHESTRATOR,
  START_RETENTION_SWEEP_ACTIVITY,
  retentionSweepInstanceId,
} from './retention.contracts.js';

const input = {
  correlationId: 'corr-retention',
  nowIso: '2026-07-18T01:00:00.000Z',
  sweepId: '44444444-4444-4444-8444-444444444444',
};
const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Retention orchestration', () => {
  it('returns exact aggregate-only sweep output', async () => {
    const runtime = sweepRuntime({
      policiesApplied: 3,
      sweepId: input.sweepId,
      totalAffected: 4,
      totalScanned: 5,
    });
    await runtime.worker.start();

    const state = await runSweep(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      policiesApplied: 3,
      sweepId: input.sweepId,
      totalAffected: 4,
      totalScanned: 5,
    });
  });

  it('finalizes and fails when an activity tries to add a private field', async () => {
    const runtime = sweepRuntime({
      policiesApplied: 1,
      reason: 'private retention failure',
      sweepId: input.sweepId,
      totalAffected: 0,
      totalScanned: 1,
    });
    await runtime.worker.start();

    const state = await runSweep(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(runtime.finalizations).toEqual([input]);
  });

  it('continues the daily singleton after detached sweep starts', async () => {
    const runtime = testRuntime();
    const starts: string[] = [];
    let resolveSecondStart: (() => void) | undefined;
    const secondStart = new Promise<void>((resolve) => {
      resolveSecondStart = resolve;
    });
    runtime.worker.addNamedOrchestrator(
      RETENTION_SCHEDULE_ORCHESTRATOR,
      RetentionScheduleOrchestrator,
    );
    runtime.worker.addNamedActivity(CALCULATE_NEXT_RETENTION_FIRE_ACTIVITY, () =>
      new Date(Date.now() + 20).toISOString(),
    );
    runtime.worker.addNamedActivity(START_RETENTION_SWEEP_ACTIVITY, (_context, value) => {
      const start = value as { sweepInstanceId: string };
      starts.push(start.sweepInstanceId);
      if (starts.length === 2) resolveSecondStart?.();
      return start.sweepInstanceId;
    });
    await runtime.worker.start();

    await runtime.client.scheduleNewOrchestration(
      RETENTION_SCHEDULE_ORCHESTRATOR,
      {},
      'careos-retention-schedule-v1',
    );
    await expect(Promise.race([secondStart, rejectAfter(2_000)])).resolves.toBeUndefined();

    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
  });
});

function sweepRuntime(result: unknown) {
  const runtime = testRuntime();
  const finalizations: unknown[] = [];
  runtime.worker.addNamedOrchestrator(RETENTION_SWEEP_ORCHESTRATOR, RetentionSweepOrchestrator);
  runtime.worker.addNamedActivity(PROCESS_RETENTION_SWEEP_ACTIVITY, () => result);
  runtime.worker.addNamedActivity(FINALIZE_RETENTION_SWEEP_FAILURE_ACTIVITY, (_context, value) => {
    finalizations.push(value);
  });
  return { ...runtime, finalizations };
}

function testRuntime() {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  workers.push(worker);
  clients.push(client);
  return { client, worker };
}

async function runSweep(runtime: ReturnType<typeof sweepRuntime>) {
  const instanceId = retentionSweepInstanceId(input.sweepId);
  await runtime.client.scheduleNewOrchestration(RETENTION_SWEEP_ORCHESTRATOR, input, instanceId);
  return runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
}

function rejectAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timed out waiting for retention schedule.')), milliseconds);
  });
}
