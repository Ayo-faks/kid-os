import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CALCULATE_NEXT_HANDOVER_DUE_FIRE_ACTIVITY,
  FIND_HANDOVER_DUE_TARGETS_ACTIVITY,
  HANDOVER_DUE_SCHEDULE_ORCHESTRATOR,
  HANDOVER_DUE_SWEEP_ORCHESTRATOR,
  PROCESS_HANDOVER_DUE_DELIVERY_ACTIVITY,
  SEND_HANDOVER_DUE_ORCHESTRATOR,
  START_HANDOVER_DUE_DELIVERY_ACTIVITY,
  START_HANDOVER_DUE_SWEEP_ACTIVITY,
} from './handover-due-reminder.contracts.js';
import {
  HandoverDueScheduleOrchestrator,
  HandoverDueSweepOrchestrator,
  SendHandoverDueOrchestrator,
} from './orchestrators/handover-due-reminder.orchestrators.js';

const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];
const target = {
  homeId: '22222222-2222-4222-8222-222222222222',
  shiftId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Handover Due orchestration', () => {
  it('fans out only opaque target IDs', async () => {
    const runtime = testRuntime();
    const starts: unknown[] = [];
    runtime.worker.addNamedOrchestrator(
      HANDOVER_DUE_SWEEP_ORCHESTRATOR,
      HandoverDueSweepOrchestrator,
    );
    runtime.worker.addNamedActivity(FIND_HANDOVER_DUE_TARGETS_ACTIVITY, () => ({
      targets: [target],
    }));
    runtime.worker.addNamedActivity(START_HANDOVER_DUE_DELIVERY_ACTIVITY, (_context, input) => {
      starts.push(input);
      return `handover-due-reminder:${target.shiftId}`;
    });
    await runtime.worker.start();
    const instanceId = await runtime.client.scheduleNewOrchestration(
      HANDOVER_DUE_SWEEP_ORCHESTRATOR,
      {
        correlationId: 'corr-handover-due',
        maxOverdueMinutes: 240,
        minOverdueMinutes: 15,
        scheduledForIso: '2026-07-18T10:00:00.000Z',
      },
      'handover-due-sweep:test',
    );

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(starts).toEqual([
      expect.objectContaining({
        ...target,
        deliveryInstanceId: `handover-due-reminder:${target.shiftId}`,
      }),
    ]);
  });

  it('rejects delivery activity output containing a free-form reason', async () => {
    const runtime = testRuntime();
    runtime.worker.addNamedOrchestrator(
      SEND_HANDOVER_DUE_ORCHESTRATOR,
      SendHandoverDueOrchestrator,
    );
    runtime.worker.addNamedActivity(PROCESS_HANDOVER_DUE_DELIVERY_ACTIVITY, () => ({
      dispatched: false,
      reason: 'private provider response',
    }));
    await runtime.worker.start();
    const instanceId = await runtime.client.scheduleNewOrchestration(
      SEND_HANDOVER_DUE_ORCHESTRATOR,
      { ...target, correlationId: 'corr-handover-due' },
      `handover-due-reminder:${target.shiftId}`,
    );

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });

  it('continues the aligned schedule after detached sweep starts', async () => {
    const runtime = testRuntime();
    const starts: string[] = [];
    let resolveSecond: (() => void) | undefined;
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    runtime.worker.addNamedOrchestrator(
      HANDOVER_DUE_SCHEDULE_ORCHESTRATOR,
      HandoverDueScheduleOrchestrator,
    );
    runtime.worker.addNamedActivity(CALCULATE_NEXT_HANDOVER_DUE_FIRE_ACTIVITY, () =>
      new Date(Date.now() + 20).toISOString(),
    );
    runtime.worker.addNamedActivity(START_HANDOVER_DUE_SWEEP_ACTIVITY, (_context, input) => {
      const start = input as { sweepInstanceId: string };
      starts.push(start.sweepInstanceId);
      if (starts.length === 2) resolveSecond?.();
      return start.sweepInstanceId;
    });
    await runtime.worker.start();
    await runtime.client.scheduleNewOrchestration(
      HANDOVER_DUE_SCHEDULE_ORCHESTRATOR,
      { intervalSeconds: 0.02 },
      'careos-handover-due-schedule-v1',
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
