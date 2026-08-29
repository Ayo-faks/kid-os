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
  FINALIZE_HANDOVER_FAILURE_ACTIVITY,
  HANDOVER_ORCHESTRATION_VERSION,
  HANDOVER_ORCHESTRATOR,
  PROCESS_HANDOVER_COMMAND_ACTIVITY,
  handoverInstanceId,
} from './handover.contracts.js';
import { HandoverOrchestrator } from './orchestrators/handover.orchestrator.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Handover emulator integration', () => {
  it('persists an ID-only completed result through the DTS emulator', async () => {
    const handoverId = uuidFromClock();
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: HANDOVER_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: HANDOVER_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(HANDOVER_ORCHESTRATOR, HandoverOrchestrator)
      .addNamedActivity(PROCESS_HANDOVER_COMMAND_ACTIVITY, () => ({
        handoverId,
        missingMandatory: [],
        status: 'completed',
        taskIds: ['77777777-7777-4777-8777-777777777777'],
      }))
      .addNamedActivity(FINALIZE_HANDOVER_FAILURE_ACTIVITY, () => undefined)
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = handoverInstanceId(handoverId);
    await client.scheduleNewOrchestration(
      HANDOVER_ORCHESTRATOR,
      {
        actor: {
          correlationId: `emulator-handover-${handoverId}`,
          kind: 'user',
          userId: '55555555-5555-4555-8555-555555555555',
        },
        authorUserId: '55555555-5555-4555-8555-555555555555',
        commandId: '66666666-6666-4666-8666-666666666666',
        handoverId,
        homeId: '22222222-2222-4222-8222-222222222222',
        shiftId: '33333333-3333-4333-8333-333333333333',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      { instanceId, version: HANDOVER_ORCHESTRATION_VERSION },
    );

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toMatchObject({
      handoverId,
      status: 'completed',
    });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `96969696-9696-4696-8969-${digits}`;
}
