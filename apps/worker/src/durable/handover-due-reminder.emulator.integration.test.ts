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

import { createStartHandoverDueDeliveryActivity } from './activities/handover-due-reminder.activities.js';
import {
  FIND_HANDOVER_DUE_TARGETS_ACTIVITY,
  HANDOVER_DUE_ORCHESTRATION_VERSION,
  HANDOVER_DUE_SWEEP_ORCHESTRATOR,
  PROCESS_HANDOVER_DUE_DELIVERY_ACTIVITY,
  SEND_HANDOVER_DUE_ORCHESTRATOR,
  START_HANDOVER_DUE_DELIVERY_ACTIVITY,
  handoverDueDeliveryInstanceId,
} from './handover-due-reminder.contracts.js';
import {
  HandoverDueSweepOrchestrator,
  SendHandoverDueOrchestrator,
} from './orchestrators/handover-due-reminder.orchestrators.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Handover Due emulator integration', () => {
  it('starts and completes an ID-only detached delivery through DTS', async () => {
    const shiftId = uuidFromClock();
    const target = {
      homeId: '22222222-2222-4222-8222-222222222222',
      shiftId,
      tenantId: '11111111-1111-4111-8111-111111111111',
    };
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: HANDOVER_DUE_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: HANDOVER_DUE_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(HANDOVER_DUE_SWEEP_ORCHESTRATOR, HandoverDueSweepOrchestrator)
      .addNamedOrchestrator(SEND_HANDOVER_DUE_ORCHESTRATOR, SendHandoverDueOrchestrator)
      .addNamedActivity(FIND_HANDOVER_DUE_TARGETS_ACTIVITY, () => ({ targets: [target] }))
      .addNamedActivity(
        START_HANDOVER_DUE_DELIVERY_ACTIVITY,
        createStartHandoverDueDeliveryActivity({
          getOrchestrationState: (instanceId, fetchPayloads) =>
            client.getOrchestrationState(instanceId, fetchPayloads),
          scheduleNewOrchestration: (orchestrator, input, options) =>
            client.scheduleNewOrchestration(orchestrator, input, options),
        }),
      )
      .addNamedActivity(PROCESS_HANDOVER_DUE_DELIVERY_ACTIVITY, () => ({ dispatched: true }))
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const sweepId = `handover-due-sweep:emulator-${shiftId}`;
    await client.scheduleNewOrchestration(
      HANDOVER_DUE_SWEEP_ORCHESTRATOR,
      {
        correlationId: sweepId,
        maxOverdueMinutes: 240,
        minOverdueMinutes: 15,
        scheduledForIso: '2026-07-18T10:00:00.000Z',
      },
      { instanceId: sweepId, version: HANDOVER_DUE_ORCHESTRATION_VERSION },
    );

    const sweep = await client.waitForOrchestrationCompletion(sweepId, true, 30);
    const delivery = await client.waitForOrchestrationCompletion(
      handoverDueDeliveryInstanceId(shiftId),
      true,
      30,
    );
    expect(sweep?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(delivery?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(delivery?.serializedOutput ?? '{}')).toEqual({ dispatched: true });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `97979797-9797-4797-8979-${digits}`;
}
