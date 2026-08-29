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

import { RotaPublishOrchestrator } from './orchestrators/rota-publish.orchestrator.js';
import {
  FINALIZE_ROTA_PUBLISH_FAILURE_ACTIVITY,
  PROCESS_ROTA_PUBLISH_COMMAND_ACTIVITY,
  ROTA_PUBLISH_ORCHESTRATION_VERSION,
  ROTA_PUBLISH_ORCHESTRATOR,
  rotaPublishInstanceId,
} from './rota-publish.contracts.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Rota Publish emulator integration', () => {
  it('persists an ID-only publication result through the DTS emulator', async () => {
    const publicationId = uuidFromClock();
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: ROTA_PUBLISH_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: ROTA_PUBLISH_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(ROTA_PUBLISH_ORCHESTRATOR, RotaPublishOrchestrator)
      .addNamedActivity(PROCESS_ROTA_PUBLISH_COMMAND_ACTIVITY, () => ({
        publicationId,
        publishedAssignmentIds: ['77777777-7777-4777-8777-777777777777'],
        status: 'published',
      }))
      .addNamedActivity(FINALIZE_ROTA_PUBLISH_FAILURE_ACTIVITY, () => undefined)
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = rotaPublishInstanceId(publicationId);
    await client.scheduleNewOrchestration(
      ROTA_PUBLISH_ORCHESTRATOR,
      {
        actor: {
          correlationId: `emulator-rota-${publicationId}`,
          kind: 'user',
          userId: '55555555-5555-4555-8555-555555555555',
        },
        commandId: '66666666-6666-4666-8666-666666666666',
        homeId: '22222222-2222-4222-8222-222222222222',
        publicationId,
        publishedByUserId: '55555555-5555-4555-8555-555555555555',
        shiftIds: ['33333333-3333-4333-8333-333333333333'],
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      { instanceId, version: ROTA_PUBLISH_ORCHESTRATION_VERSION },
    );

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toMatchObject({
      publicationId,
      status: 'published',
    });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `94949494-9494-4494-8949-${digits}`;
}
