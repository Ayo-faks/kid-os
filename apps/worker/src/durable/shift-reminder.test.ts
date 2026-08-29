import {
  ActivityContext,
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calculateNextShiftReminderFireActivity,
  createStartShiftReminderDeliveryActivity,
  createStartShiftReminderSweepActivity,
} from './activities/shift-reminder.activities.js';
import {
  ShiftReminderScheduleOrchestrator,
  SendShiftReminderOrchestrator,
  ShiftReminderSweepOrchestrator,
} from './orchestrators/shift-reminder.orchestrators.js';
import {
  CALCULATE_NEXT_SHIFT_REMINDER_FIRE_ACTIVITY,
  FIND_UPCOMING_SHIFTS_ACTIVITY,
  PROCESS_SHIFT_REMINDER_DELIVERY_ACTIVITY,
  SEND_SHIFT_REMINDER_ORCHESTRATOR,
  SHIFT_REMINDER_ORCHESTRATION_VERSION,
  SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR,
  SHIFT_REMINDER_SWEEP_ORCHESTRATOR,
  START_SHIFT_REMINDER_DELIVERY_ACTIVITY,
  START_SHIFT_REMINDER_SWEEP_ACTIVITY,
  shiftReminderSweepInstanceId,
} from './shift-reminder.contracts.js';

const runningWorkers: TestOrchestrationWorker[] = [];
const runningClients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(runningWorkers.splice(0).map((worker) => worker.stop()));
  await Promise.all(runningClients.splice(0).map((client) => client.stop()));
});

describe('Durable Shift Reminder proof of concept', () => {
  it('runs an eternal aligned timer loop and starts unique sweeps', async () => {
    const { client, worker } = testRuntime();
    const starts: string[] = [];
    let resolveThirdStart: (() => void) | undefined;
    const thirdStart = new Promise<void>((resolve) => {
      resolveThirdStart = resolve;
    });

    worker.addNamedOrchestrator(
      SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR,
      ShiftReminderScheduleOrchestrator,
    );
    worker.addNamedActivity(
      CALCULATE_NEXT_SHIFT_REMINDER_FIRE_ACTIVITY,
      calculateNextShiftReminderFireActivity,
    );
    worker.addNamedActivity(START_SHIFT_REMINDER_SWEEP_ACTIVITY, (_context, input) => {
      const sweep = input as { sweepInstanceId: string };
      starts.push(sweep.sweepInstanceId);
      if (starts.length === 3) resolveThirdStart?.();
      return sweep.sweepInstanceId;
    });
    await worker.start();

    await client.scheduleNewOrchestration(
      SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR,
      { intervalSeconds: 0.02 },
      'careos-shift-reminder-schedule',
    );
    await expect(Promise.race([thirdStart, rejectAfter(2_000)])).resolves.toBeUndefined();
    await worker.stop();

    expect(starts).toHaveLength(3);
    expect(new Set(starts).size).toBe(3);
    expect(starts.every((id) => id.length <= 100)).toBe(true);
  });

  it('fans out deterministic delivery starts without waiting for delivery completion', async () => {
    const { client, worker } = testRuntime();
    const starts: string[] = [];
    worker.addNamedOrchestrator(SHIFT_REMINDER_SWEEP_ORCHESTRATOR, ShiftReminderSweepOrchestrator);
    worker.addNamedActivity(FIND_UPCOMING_SHIFTS_ACTIVITY, () => ({
      shifts: [
        {
          homeId: '22222222-2222-4222-8222-222222222222',
          shiftId: '33333333-3333-4333-8333-333333333333',
          startsAtIso: '2026-07-18T10:00:00.000Z',
          tenantId: '11111111-1111-4111-8111-111111111111',
        },
        {
          homeId: '55555555-5555-4555-8555-555555555555',
          shiftId: '66666666-6666-4666-8666-666666666666',
          startsAtIso: '2026-07-18T10:05:00.000Z',
          tenantId: '44444444-4444-4444-8444-444444444444',
        },
      ],
    }));
    worker.addNamedActivity(START_SHIFT_REMINDER_DELIVERY_ACTIVITY, (_context, input) => {
      const delivery = input as { deliveryInstanceId: string };
      starts.push(delivery.deliveryInstanceId);
      return delivery.deliveryInstanceId;
    });
    await worker.start();

    const instanceId = await client.scheduleNewOrchestration(
      SHIFT_REMINDER_SWEEP_ORCHESTRATOR,
      {
        correlationId: 'shift-reminder-sweep:20260718T093000000Z',
        maxLookaheadMinutes: 35,
        minLookaheadMinutes: 25,
        scheduledForIso: '2026-07-18T09:30:00.000Z',
      },
      'shift-reminder-sweep:20260718T093000000Z',
    );
    const state = await client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      deliveryInstanceIds: starts,
      scanned: 2,
    });
    expect(starts).toEqual([
      'shift-reminder:33333333-3333-4333-8333-333333333333',
      'shift-reminder:66666666-6666-4666-8666-666666666666',
    ]);
  });

  it('starts sweep and delivery orchestrations with pinned versions and opaque IDs', async () => {
    const scheduleNewOrchestration = vi
      .fn()
      .mockImplementation((_name, _input, options) =>
        Promise.resolve((options as { instanceId: string }).instanceId),
      );
    const client = {
      getOrchestrationState: vi.fn().mockResolvedValue(undefined),
      scheduleNewOrchestration,
    };
    const context = new ActivityContext('launcher', 1);

    const sweepId = shiftReminderSweepInstanceId('2026-07-18T09:30:00.000Z');
    await createStartShiftReminderSweepActivity(client)(context, {
      correlationId: sweepId,
      maxLookaheadMinutes: 35,
      minLookaheadMinutes: 25,
      scheduledForIso: '2026-07-18T09:30:00.000Z',
      sweepInstanceId: sweepId,
    });
    await createStartShiftReminderDeliveryActivity(client)(context, {
      correlationId: `${sweepId}:shift`,
      deliveryInstanceId: 'shift-reminder:33333333-3333-4333-8333-333333333333',
      homeId: '22222222-2222-4222-8222-222222222222',
      shiftId: '33333333-3333-4333-8333-333333333333',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });

    expect(scheduleNewOrchestration).toHaveBeenNthCalledWith(
      1,
      SHIFT_REMINDER_SWEEP_ORCHESTRATOR,
      expect.objectContaining({ scheduledForIso: '2026-07-18T09:30:00.000Z' }),
      { instanceId: sweepId, version: SHIFT_REMINDER_ORCHESTRATION_VERSION },
    );
    expect(scheduleNewOrchestration).toHaveBeenNthCalledWith(
      2,
      SEND_SHIFT_REMINDER_ORCHESTRATOR,
      {
        correlationId: `${sweepId}:shift`,
        homeId: '22222222-2222-4222-8222-222222222222',
        shiftId: '33333333-3333-4333-8333-333333333333',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      {
        instanceId: 'shift-reminder:33333333-3333-4333-8333-333333333333',
        version: SHIFT_REMINDER_ORCHESTRATION_VERSION,
      },
    );
  });

  it('reconciles a detached start when the scheduler succeeded but the response was lost', async () => {
    const deliveryInstanceId = 'shift-reminder:33333333-3333-4333-8333-333333333333';
    const client = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValue({ runtimeStatus: OrchestrationStatus.RUNNING }),
      scheduleNewOrchestration: vi.fn().mockRejectedValue(new Error('gRPC response lost')),
    };

    await expect(
      createStartShiftReminderDeliveryActivity(client)(new ActivityContext('launcher', 1), {
        correlationId: 'corr-1',
        deliveryInstanceId,
        homeId: '22222222-2222-4222-8222-222222222222',
        shiftId: '33333333-3333-4333-8333-333333333333',
        tenantId: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toBe(deliveryInstanceId);
    expect(client.getOrchestrationState).toHaveBeenCalledWith(deliveryInstanceId, false);
  });

  it('preserves the start failure when no deterministic instance exists', async () => {
    const startError = new Error('scheduler unavailable');
    const client = {
      getOrchestrationState: vi.fn().mockResolvedValue(undefined),
      scheduleNewOrchestration: vi.fn().mockRejectedValue(startError),
    };

    await expect(
      createStartShiftReminderDeliveryActivity(client)(new ActivityContext('launcher', 1), {
        correlationId: 'corr-1',
        deliveryInstanceId: 'shift-reminder:33333333-3333-4333-8333-333333333333',
        homeId: '22222222-2222-4222-8222-222222222222',
        shiftId: '33333333-3333-4333-8333-333333333333',
        tenantId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toBe(startError);
  });

  it.each([
    {
      expected: { dispatched: false, outcomeCode: 'shift-not-found' },
      title: 'missing shift',
    },
    {
      expected: { dispatched: false, outcomeCode: 'already-reminded' },
      title: 'already reminded shift',
    },
    {
      expected: { dispatched: false, outcomeCode: 'provider-not-delivered' },
      title: 'provider failure',
    },
    {
      expected: { dispatched: true },
      title: 'confirmed delivery',
    },
  ])('preserves the $title delivery branch', async ({ expected }) => {
    const { client, worker } = testRuntime();
    worker.addNamedOrchestrator(SEND_SHIFT_REMINDER_ORCHESTRATOR, SendShiftReminderOrchestrator);
    worker.addNamedActivity(PROCESS_SHIFT_REMINDER_DELIVERY_ACTIVITY, () => expected);
    await worker.start();

    const instanceId = await client.scheduleNewOrchestration(
      SEND_SHIFT_REMINDER_ORCHESTRATOR,
      {
        correlationId: 'shift-reminder-sweep:20260718T093000000Z:shift',
        homeId: '22222222-2222-4222-8222-222222222222',
        shiftId: '33333333-3333-4333-8333-333333333333',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      `delivery-${String(expected.outcomeCode ?? 'success')}`,
    );
    const state = await client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual(expected);
  });
});

function testRuntime(): {
  readonly client: TestOrchestrationClient;
  readonly worker: TestOrchestrationWorker;
} {
  const backend = new InMemoryOrchestrationBackend();
  const client = new TestOrchestrationClient(backend);
  const worker = new TestOrchestrationWorker(backend);
  runningClients.push(client);
  runningWorkers.push(worker);
  return { client, worker };
}

function rejectAfter(milliseconds: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(
      () => reject(new Error('Timed out waiting for Durable schedule iterations.')),
      milliseconds,
    );
  });
}
