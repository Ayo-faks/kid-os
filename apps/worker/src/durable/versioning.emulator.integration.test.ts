import {
  OrchestrationStatus,
  VersionFailureStrategy,
  VersionMatchStrategy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';
import {
  createAzureManagedClient,
  createAzureManagedWorkerBuilder,
} from '@microsoft/durabletask-js-azuremanaged';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectDurableVersionRetirement } from './version-retirement.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const ORCHESTRATOR = 'VersionRoutingProbeOrchestrator';
const RELEASE_EVENT = 'releaseVersionProbe';
const VERSION_ONE = '1.0.0';
const VERSION_TWO = '2.0.0';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable orchestration version routing', () => {
  it('retains V1 for in-flight work while routing new starts to V2', async () => {
    const client = createAzureManagedClient(connectionString);
    const versionOneWorker = versionedWorker(VERSION_ONE, VersionOneProbeOrchestrator);
    stoppables.push(versionOneWorker, client);
    await versionOneWorker.start();

    const versionOneInstance = `version-probe-v1-${Date.now()}-${process.pid}`;
    await client.scheduleNewOrchestration(
      ORCHESTRATOR,
      {},
      {
        instanceId: versionOneInstance,
        version: VERSION_ONE,
      },
    );
    await client.waitForOrchestrationStart(versionOneInstance, false, 30);

    await expect(inspectDurableVersionRetirement(client, VERSION_ONE)).resolves.toMatchObject({
      activeInstanceIds: expect.arrayContaining([versionOneInstance]),
      canRetire: false,
    });

    const versionTwoWorker = versionedWorker(VERSION_TWO, VersionTwoProbeOrchestrator);
    stoppables.push(versionTwoWorker);
    await versionTwoWorker.start();

    await expect(
      client.scheduleNewOrchestration(
        ORCHESTRATOR,
        {},
        {
          instanceId: versionOneInstance,
          version: VERSION_TWO,
        },
      ),
    ).rejects.toThrow();
    expect((await client.getOrchestrationState(versionOneInstance, false))?.runtimeStatus).toBe(
      OrchestrationStatus.RUNNING,
    );

    await client.raiseOrchestrationEvent(versionOneInstance, RELEASE_EVENT, 'continue');
    const versionOneCompleted = await client.waitForOrchestrationCompletion(
      versionOneInstance,
      true,
      30,
    );
    expect(versionOneCompleted?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(versionOneCompleted?.serializedOutput ?? '{}')).toEqual({
      workerVersion: VERSION_ONE,
    });
    await expect(inspectDurableVersionRetirement(client, VERSION_ONE)).resolves.toEqual({
      activeInstanceIds: [],
      canRetire: true,
      version: VERSION_ONE,
    });

    const versionTwoInstance = `version-probe-v2-${Date.now()}-${process.pid}`;
    await client.scheduleNewOrchestration(
      ORCHESTRATOR,
      {},
      {
        instanceId: versionTwoInstance,
        version: VERSION_TWO,
      },
    );
    await client.raiseOrchestrationEvent(versionTwoInstance, RELEASE_EVENT, 'continue');
    const versionTwoCompleted = await client.waitForOrchestrationCompletion(
      versionTwoInstance,
      true,
      30,
    );
    expect(versionTwoCompleted?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(versionTwoCompleted?.serializedOutput ?? '{}')).toEqual({
      workerVersion: VERSION_TWO,
    });
  }, 90_000);
});

function versionedWorker(version: string, orchestrator: TOrchestrator) {
  return createAzureManagedWorkerBuilder(connectionString)
    .versioning({
      defaultVersion: version,
      failureStrategy: VersionFailureStrategy.Reject,
      matchStrategy: VersionMatchStrategy.Strict,
      version,
    })
    .addNamedOrchestrator(ORCHESTRATOR, orchestrator)
    .build();
}

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task executes async iterators.
async function* versionOneProbeOrchestrator(
  context: OrchestrationContext,
): AsyncGenerator<Task<unknown>, { readonly workerVersion: string }, unknown> {
  yield context.waitForExternalEvent(RELEASE_EVENT);
  return { workerVersion: VERSION_ONE };
}

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task executes async iterators.
async function* versionTwoProbeOrchestrator(
  context: OrchestrationContext,
): AsyncGenerator<Task<unknown>, { readonly workerVersion: string }, unknown> {
  yield context.waitForExternalEvent(RELEASE_EVENT);
  return { workerVersion: VERSION_TWO };
}

const VersionOneProbeOrchestrator = versionOneProbeOrchestrator as unknown as TOrchestrator;
const VersionTwoProbeOrchestrator = versionTwoProbeOrchestrator as unknown as TOrchestrator;
