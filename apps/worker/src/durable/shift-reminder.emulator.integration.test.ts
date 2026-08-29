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

import {
  calculateNextShiftReminderFireActivity,
  createStartShiftReminderDeliveryActivity,
} from './activities/shift-reminder.activities.js';
import {
  SendShiftReminderOrchestrator,
  ShiftReminderScheduleOrchestrator,
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
} from './shift-reminder.contracts.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';

interface Stoppable {
  stop(): Promise<void>;
}

const stoppables: Stoppable[] = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Shift Reminder emulator integration', () => {
  it('runs a versioned sweep and detached delivery over the DTS gRPC boundary', async () => {
    const client = createAzureManagedClient(connectionString);
    const starter = {
      getOrchestrationState: (instanceId: string, fetchPayloads?: boolean) =>
        client.getOrchestrationState(instanceId, fetchPayloads),
      scheduleNewOrchestration: (orchestrator: string, input: unknown, options: object) =>
        client.scheduleNewOrchestration(orchestrator, input, options),
    };
    const worker = versionedBuilder()
      .addNamedOrchestrator(SHIFT_REMINDER_SWEEP_ORCHESTRATOR, ShiftReminderSweepOrchestrator)
      .addNamedOrchestrator(SEND_SHIFT_REMINDER_ORCHESTRATOR, SendShiftReminderOrchestrator)
      .addNamedActivity(FIND_UPCOMING_SHIFTS_ACTIVITY, (context) => ({
        shifts: [
          {
            homeId: '22222222-2222-4222-8222-222222222222',
            shiftId: context.orchestrationId,
            startsAtIso: new Date(Date.now() + 30 * 60_000).toISOString(),
            tenantId: '11111111-1111-4111-8111-111111111111',
          },
        ],
      }))
      .addNamedActivity(
        START_SHIFT_REMINDER_DELIVERY_ACTIVITY,
        createStartShiftReminderDeliveryActivity(starter),
      )
      .addNamedActivity(PROCESS_SHIFT_REMINDER_DELIVERY_ACTIVITY, () => ({ dispatched: true }))
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const uniqueSuffix = `${Date.now()}-${process.pid}`;
    const sweepInstanceId = `emulator-shift-sweep-${uniqueSuffix}`;
    await client.scheduleNewOrchestration(
      SHIFT_REMINDER_SWEEP_ORCHESTRATOR,
      {
        correlationId: sweepInstanceId,
        maxLookaheadMinutes: 35,
        minLookaheadMinutes: 25,
        scheduledForIso: new Date().toISOString(),
      },
      { instanceId: sweepInstanceId, version: SHIFT_REMINDER_ORCHESTRATION_VERSION },
    );
    const sweep = await client.waitForOrchestrationCompletion(sweepInstanceId, true, 30);
    expect(sweep?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    const output = parseSweepOutput(sweep?.serializedOutput);
    expect(output.scanned).toBe(1);

    const delivery = await client.waitForOrchestrationCompletion(
      output.deliveryInstanceIds[0] ?? '',
      true,
      30,
    );
    expect(delivery?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(delivery?.serializedOutput ?? '{}')).toEqual({ dispatched: true });
  }, 60_000);

  it('fires the eternal timer loop and can be terminated cleanly', async () => {
    const client = createAzureManagedClient(connectionString);
    let fireCalculationCount = 0;
    const stagedFireCalculation: typeof calculateNextShiftReminderFireActivity = (
      context,
      input,
    ) => {
      fireCalculationCount += 1;
      if (fireCalculationCount === 1) {
        return calculateNextShiftReminderFireActivity(context, input);
      }
      return new Date(new Date(input.afterIso).getTime() + 60_000).toISOString();
    };
    let resolveSweepStart: ((input: unknown) => void) | undefined;
    const sweepStarted = new Promise<unknown>((resolve) => {
      resolveSweepStart = resolve;
    });
    const worker = versionedBuilder()
      .addNamedOrchestrator(SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR, ShiftReminderScheduleOrchestrator)
      .addNamedActivity(CALCULATE_NEXT_SHIFT_REMINDER_FIRE_ACTIVITY, stagedFireCalculation)
      .addNamedActivity(START_SHIFT_REMINDER_SWEEP_ACTIVITY, (_context, input) => {
        resolveSweepStart?.(input);
        return 'emulator-sweep-started';
      })
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = `emulator-shift-schedule-${Date.now()}-${process.pid}`;
    await client.scheduleNewOrchestration(
      SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR,
      { intervalSeconds: 0.1 },
      { instanceId, version: SHIFT_REMINDER_ORCHESTRATION_VERSION },
    );
    await expect(Promise.race([sweepStarted, rejectAfter(15_000)])).resolves.toMatchObject({
      maxLookaheadMinutes: 35,
      minLookaheadMinutes: 25,
    });
    await waitForNextFireAfter(client, instanceId, Date.now() + 30_000);

    await client.terminateOrchestration(instanceId, 'emulator-test-complete');
    const terminated = await client.waitForOrchestrationCompletion(instanceId, false, 30);
    expect(terminated?.runtimeStatus).toBe(OrchestrationStatus.TERMINATED);
  }, 60_000);
});

function versionedBuilder() {
  return createAzureManagedWorkerBuilder(connectionString).versioning({
    defaultVersion: SHIFT_REMINDER_ORCHESTRATION_VERSION,
    failureStrategy: VersionFailureStrategy.Reject,
    matchStrategy: VersionMatchStrategy.Strict,
    version: SHIFT_REMINDER_ORCHESTRATION_VERSION,
  });
}

function parseSweepOutput(serializedOutput: string | undefined): {
  readonly deliveryInstanceIds: readonly string[];
  readonly scanned: number;
} {
  const value: unknown = JSON.parse(serializedOutput ?? '{}');
  if (
    typeof value !== 'object' ||
    value === null ||
    !('deliveryInstanceIds' in value) ||
    !Array.isArray(value.deliveryInstanceIds) ||
    !value.deliveryInstanceIds.every((id) => typeof id === 'string') ||
    !('scanned' in value) ||
    typeof value.scanned !== 'number'
  ) {
    throw new Error('Durable shift reminder sweep returned an invalid output.');
  }
  return { deliveryInstanceIds: value.deliveryInstanceIds, scanned: value.scanned };
}

function rejectAfter(milliseconds: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('Timed out waiting for the DTS emulator.')), milliseconds);
  });
}

async function waitForNextFireAfter(
  client: ReturnType<typeof createAzureManagedClient>,
  instanceId: string,
  minimumTimestamp: number,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await client.getOrchestrationState(instanceId, true);
    if (state?.serializedCustomStatus !== undefined) {
      const status = JSON.parse(state.serializedCustomStatus) as { nextFireAtIso?: unknown };
      if (
        typeof status.nextFireAtIso === 'string' &&
        Date.parse(status.nextFireAtIso) >= minimumTimestamp
      ) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Shift reminder schedule ${instanceId} did not enter its next timer cycle.`);
}
