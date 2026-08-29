import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SafeguardingDigestScheduleOrchestrator,
  SafeguardingDigestSweepOrchestrator,
  SendSafeguardingDigestOrchestrator,
} from './orchestrators/safeguarding-digest.orchestrators.js';
import {
  CALCULATE_NEXT_SAFEGUARDING_DIGEST_FIRE_ACTIVITY,
  FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY,
  PROCESS_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
  SAFEGUARDING_DIGEST_SCHEDULE_ORCHESTRATOR,
  SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
  SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR,
  START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
  START_SAFEGUARDING_DIGEST_SWEEP_ACTIVITY,
} from './safeguarding-digest.contracts.js';

const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];
const target = {
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Safeguarding Digest orchestration', () => {
  it('fans out only opaque home targets and bounded timestamps', async () => {
    const runtime = testRuntime();
    const starts: unknown[] = [];
    runtime.worker.addNamedOrchestrator(
      SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
      SafeguardingDigestSweepOrchestrator,
    );
    runtime.worker.addNamedActivity(FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY, () => ({
      targets: [target],
    }));
    runtime.worker.addNamedActivity(
      START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
      (_context, input) => {
        starts.push(input);
        return 'safeguarding-digest:delivery';
      },
    );
    await runtime.worker.start();
    const instanceId = await runtime.client.scheduleNewOrchestration(
      SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
      {
        correlationId: 'corr-digest',
        nowIso: '2026-07-20T07:00:00.000Z',
        sinceIso: '2026-07-13T07:00:00.000Z',
      },
      'safeguarding-digest-sweep:test',
    );
    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(starts).toEqual([
      expect.objectContaining({
        ...target,
        nowIso: '2026-07-20T07:00:00.000Z',
        sinceIso: '2026-07-13T07:00:00.000Z',
      }),
    ]);
  });

  it('rejects private target and delivery output fields', async () => {
    const targetRuntime = testRuntime();
    targetRuntime.worker.addNamedOrchestrator(
      SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
      SafeguardingDigestSweepOrchestrator,
    );
    targetRuntime.worker.addNamedActivity(FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY, () => ({
      targets: [{ ...target, sensitiveEmailDrafts: 3 }],
    }));
    targetRuntime.worker.addNamedActivity(START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY, () => 'x');
    await targetRuntime.worker.start();
    const targetId = await targetRuntime.client.scheduleNewOrchestration(
      SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
      {
        correlationId: 'corr-private-target',
        nowIso: '2026-07-20T07:00:00.000Z',
        sinceIso: '2026-07-13T07:00:00.000Z',
      },
      'safeguarding-digest-sweep:private',
    );
    const targetState = await targetRuntime.client.waitForOrchestrationCompletion(
      targetId,
      true,
      5,
    );
    expect(targetState?.runtimeStatus).toBe(OrchestrationStatus.FAILED);

    const deliveryRuntime = testRuntime();
    deliveryRuntime.worker.addNamedOrchestrator(
      SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR,
      SendSafeguardingDigestOrchestrator,
    );
    deliveryRuntime.worker.addNamedActivity(PROCESS_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY, () => ({
      dispatched: false,
      reason: 'private provider detail',
    }));
    await deliveryRuntime.worker.start();
    const deliveryId = await deliveryRuntime.client.scheduleNewOrchestration(
      SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR,
      {
        ...target,
        correlationId: 'corr-private-delivery',
        nowIso: '2026-07-20T07:00:00.000Z',
        sinceIso: '2026-07-13T07:00:00.000Z',
      },
      'safeguarding-digest:private',
    );
    const deliveryState = await deliveryRuntime.client.waitForOrchestrationCompletion(
      deliveryId,
      true,
      5,
    );
    expect(deliveryState?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });

  it('continues the weekly singleton after detached sweep starts', async () => {
    const runtime = testRuntime();
    const starts: string[] = [];
    let resolveSecond: (() => void) | undefined;
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    runtime.worker.addNamedOrchestrator(
      SAFEGUARDING_DIGEST_SCHEDULE_ORCHESTRATOR,
      SafeguardingDigestScheduleOrchestrator,
    );
    runtime.worker.addNamedActivity(CALCULATE_NEXT_SAFEGUARDING_DIGEST_FIRE_ACTIVITY, () =>
      new Date(Date.now() + 20).toISOString(),
    );
    runtime.worker.addNamedActivity(START_SAFEGUARDING_DIGEST_SWEEP_ACTIVITY, (_context, input) => {
      const start = input as { sweepInstanceId: string };
      starts.push(start.sweepInstanceId);
      if (starts.length === 2) resolveSecond?.();
      return start.sweepInstanceId;
    });
    await runtime.worker.start();
    await runtime.client.scheduleNewOrchestration(
      SAFEGUARDING_DIGEST_SCHEDULE_ORCHESTRATOR,
      { intervalSeconds: 0.02 },
      'careos-safeguarding-digest-schedule-v1',
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
