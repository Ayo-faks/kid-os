import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CALCULATE_NEXT_MISSING_FIELDS_FIRE_ACTIVITY,
  FIND_MISSING_FIELDS_TARGETS_ACTIVITY,
  MISSING_FIELDS_SCHEDULE_ORCHESTRATOR,
  MISSING_FIELDS_SWEEP_ORCHESTRATOR,
  PROCESS_MISSING_FIELDS_DELIVERY_ACTIVITY,
  SEND_MISSING_FIELDS_ORCHESTRATOR,
  START_MISSING_FIELDS_DELIVERY_ACTIVITY,
  START_MISSING_FIELDS_SWEEP_ACTIVITY,
} from './missing-fields-audit.contracts.js';
import {
  MissingFieldsScheduleOrchestrator,
  MissingFieldsSweepOrchestrator,
  SendMissingFieldsOrchestrator,
} from './orchestrators/missing-fields-audit.orchestrators.js';

const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];
const target = {
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Missing Fields orchestration', () => {
  it('fans out only opaque incident targets', async () => {
    const runtime = testRuntime();
    const starts: unknown[] = [];
    runtime.worker.addNamedOrchestrator(
      MISSING_FIELDS_SWEEP_ORCHESTRATOR,
      MissingFieldsSweepOrchestrator,
    );
    runtime.worker.addNamedActivity(FIND_MISSING_FIELDS_TARGETS_ACTIVITY, () => ({
      targets: [target],
    }));
    runtime.worker.addNamedActivity(START_MISSING_FIELDS_DELIVERY_ACTIVITY, (_context, input) => {
      starts.push(input);
      return `missing-fields-reminder:${target.incidentId}`;
    });
    await runtime.worker.start();
    const instanceId = await runtime.client.scheduleNewOrchestration(
      MISSING_FIELDS_SWEEP_ORCHESTRATOR,
      {
        correlationId: 'corr-missing-fields',
        minAgeMinutes: 1_440,
        scheduledForIso: '2026-07-18T00:00:00.000Z',
      },
      'missing-fields-sweep:test',
    );

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(starts).toEqual([
      expect.objectContaining({
        ...target,
        deliveryInstanceId: `missing-fields-reminder:${target.incidentId}`,
      }),
    ]);
  });

  it('rejects target or delivery output containing private fields', async () => {
    const targetRuntime = testRuntime();
    targetRuntime.worker.addNamedOrchestrator(
      MISSING_FIELDS_SWEEP_ORCHESTRATOR,
      MissingFieldsSweepOrchestrator,
    );
    targetRuntime.worker.addNamedActivity(FIND_MISSING_FIELDS_TARGETS_ACTIVITY, () => ({
      targets: [{ ...target, missingFields: ['private'] }],
    }));
    targetRuntime.worker.addNamedActivity(START_MISSING_FIELDS_DELIVERY_ACTIVITY, () => 'unused');
    await targetRuntime.worker.start();
    const targetInstance = await targetRuntime.client.scheduleNewOrchestration(
      MISSING_FIELDS_SWEEP_ORCHESTRATOR,
      {
        correlationId: 'corr-private-target',
        minAgeMinutes: 1_440,
        scheduledForIso: '2026-07-18T00:00:00.000Z',
      },
      'missing-fields-sweep:private-target',
    );
    const targetState = await targetRuntime.client.waitForOrchestrationCompletion(
      targetInstance,
      true,
      5,
    );
    expect(targetState?.runtimeStatus).toBe(OrchestrationStatus.FAILED);

    const deliveryRuntime = testRuntime();
    deliveryRuntime.worker.addNamedOrchestrator(
      SEND_MISSING_FIELDS_ORCHESTRATOR,
      SendMissingFieldsOrchestrator,
    );
    deliveryRuntime.worker.addNamedActivity(PROCESS_MISSING_FIELDS_DELIVERY_ACTIVITY, () => ({
      dispatched: false,
      reason: 'private provider text',
    }));
    await deliveryRuntime.worker.start();
    const deliveryInstance = await deliveryRuntime.client.scheduleNewOrchestration(
      SEND_MISSING_FIELDS_ORCHESTRATOR,
      { ...target, correlationId: 'corr-private-delivery' },
      `missing-fields-reminder:${target.incidentId}`,
    );
    const deliveryState = await deliveryRuntime.client.waitForOrchestrationCompletion(
      deliveryInstance,
      true,
      5,
    );
    expect(deliveryState?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });

  it('continues the aligned schedule after detached sweep starts', async () => {
    const runtime = testRuntime();
    const starts: string[] = [];
    let resolveSecond: (() => void) | undefined;
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    runtime.worker.addNamedOrchestrator(
      MISSING_FIELDS_SCHEDULE_ORCHESTRATOR,
      MissingFieldsScheduleOrchestrator,
    );
    runtime.worker.addNamedActivity(CALCULATE_NEXT_MISSING_FIELDS_FIRE_ACTIVITY, () =>
      new Date(Date.now() + 20).toISOString(),
    );
    runtime.worker.addNamedActivity(START_MISSING_FIELDS_SWEEP_ACTIVITY, (_context, input) => {
      const start = input as { sweepInstanceId: string };
      starts.push(start.sweepInstanceId);
      if (starts.length === 2) resolveSecond?.();
      return start.sweepInstanceId;
    });
    await runtime.worker.start();
    await runtime.client.scheduleNewOrchestration(
      MISSING_FIELDS_SCHEDULE_ORCHESTRATOR,
      { intervalSeconds: 0.02 },
      'careos-missing-fields-schedule-v1',
    );

    await expect(Promise.race([second, rejectAfter(2_000)])).resolves.toBeUndefined();

    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
  });
});

function testRuntime() {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  workers.push(worker);
  clients.push(client);
  return { client, worker };
}

function rejectAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timed out waiting for schedule.')), milliseconds);
  });
}
