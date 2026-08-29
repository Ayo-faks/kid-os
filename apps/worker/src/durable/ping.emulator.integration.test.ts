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

import { PingOrchestrator } from './orchestrators/ping.orchestrator.js';
import {
  FINALIZE_PING_FAILURE_ACTIVITY,
  PING_ORCHESTRATION_VERSION,
  PING_ORCHESTRATOR,
  PROCESS_PING_COMMAND_ACTIVITY,
  pingInstanceId,
} from './ping.contracts.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Ping emulator integration', () => {
  it('persists only operational status through the DTS emulator', async () => {
    const pingId = uuidFromClock();
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: PING_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: PING_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(PING_ORCHESTRATOR, PingOrchestrator)
      .addNamedActivity(PROCESS_PING_COMMAND_ACTIVITY, () => ({
        httpStatus: 200,
        pingId,
        status: 'healthy',
      }))
      .addNamedActivity(FINALIZE_PING_FAILURE_ACTIVITY, () => undefined)
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = pingInstanceId(pingId);
    await client.scheduleNewOrchestration(
      PING_ORCHESTRATOR,
      {
        commandId: '66666666-6666-4666-8666-666666666666',
        correlationId: `emulator-ping-${pingId}`,
        pingId,
      },
      { instanceId, version: PING_ORCHESTRATION_VERSION },
    );

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({
      httpStatus: 200,
      pingId,
      status: 'healthy',
    });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `95959595-9595-4595-8959-${digits}`;
}
