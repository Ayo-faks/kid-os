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

import { createStartMissingFieldsDeliveryActivity } from './activities/missing-fields-audit.activities.js';
import {
  FIND_MISSING_FIELDS_TARGETS_ACTIVITY,
  MISSING_FIELDS_ORCHESTRATION_VERSION,
  MISSING_FIELDS_SWEEP_ORCHESTRATOR,
  PROCESS_MISSING_FIELDS_DELIVERY_ACTIVITY,
  SEND_MISSING_FIELDS_ORCHESTRATOR,
  START_MISSING_FIELDS_DELIVERY_ACTIVITY,
  missingFieldsDeliveryInstanceId,
} from './missing-fields-audit.contracts.js';
import {
  MissingFieldsSweepOrchestrator,
  SendMissingFieldsOrchestrator,
} from './orchestrators/missing-fields-audit.orchestrators.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Missing Fields emulator integration', () => {
  it('starts and completes an ID-only detached delivery through DTS', async () => {
    const incidentId = uuidFromClock();
    const target = {
      homeId: '22222222-2222-4222-8222-222222222222',
      incidentId,
      tenantId: '11111111-1111-4111-8111-111111111111',
    };
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: MISSING_FIELDS_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: MISSING_FIELDS_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(MISSING_FIELDS_SWEEP_ORCHESTRATOR, MissingFieldsSweepOrchestrator)
      .addNamedOrchestrator(SEND_MISSING_FIELDS_ORCHESTRATOR, SendMissingFieldsOrchestrator)
      .addNamedActivity(FIND_MISSING_FIELDS_TARGETS_ACTIVITY, () => ({ targets: [target] }))
      .addNamedActivity(
        START_MISSING_FIELDS_DELIVERY_ACTIVITY,
        createStartMissingFieldsDeliveryActivity({
          getOrchestrationState: (instanceId, fetchPayloads) =>
            client.getOrchestrationState(instanceId, fetchPayloads),
          scheduleNewOrchestration: (orchestrator, input, options) =>
            client.scheduleNewOrchestration(orchestrator, input, options),
        }),
      )
      .addNamedActivity(PROCESS_MISSING_FIELDS_DELIVERY_ACTIVITY, () => ({ dispatched: true }))
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const sweepId = `missing-fields-sweep:emulator-${incidentId}`;
    await client.scheduleNewOrchestration(
      MISSING_FIELDS_SWEEP_ORCHESTRATOR,
      {
        correlationId: sweepId,
        minAgeMinutes: 1_440,
        scheduledForIso: '2026-07-18T00:00:00.000Z',
      },
      { instanceId: sweepId, version: MISSING_FIELDS_ORCHESTRATION_VERSION },
    );

    const sweep = await client.waitForOrchestrationCompletion(sweepId, true, 30);
    const delivery = await client.waitForOrchestrationCompletion(
      missingFieldsDeliveryInstanceId(incidentId),
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
  return `98989898-9898-4898-8989-${digits}`;
}
