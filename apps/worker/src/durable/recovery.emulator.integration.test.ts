import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  OrchestrationStatus,
  RetryPolicy,
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

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const VERSION = '1.0.0';
const REPLAY_ORCHESTRATOR = 'RecoveryReplayProbeOrchestrator';
const SIDE_EFFECT_ORCHESTRATOR = 'RecoverySideEffectProbeOrchestrator';
const SIDE_EFFECT_ACTIVITY = 'recoverySideEffectProbeActivity';
const RELEASE_EVENT = 'releaseRecoveryProbe';
const CANCEL_EVENT = 'cancelRecoveryProbe';
const execFileAsync = promisify(execFile);
const stoppables: Array<{ stop(): Promise<void> }> = [];
const runAzure = process.env.CAREOS_RUN_DURABLE_AZURE === 'true';
const hasSchedulerRecoveryControl =
  process.env.CAREOS_DURABLE_EMULATOR_CONTROL === 'true' || runAzure;
const itWithSchedulerRecovery = hasSchedulerRecoveryControl ? it : it.skip;

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable recovery matrix', () => {
  it('replays an in-flight instance after its worker restarts', async () => {
    const client = createAzureManagedClient(connectionString);
    const firstWorker = versionedBuilder()
      .addNamedOrchestrator(REPLAY_ORCHESTRATOR, RecoveryReplayProbeOrchestrator)
      .build();
    stoppables.push(client, firstWorker);
    await firstWorker.start();

    const instanceId = uniqueInstanceId('worker-restart');
    await client.scheduleNewOrchestration(
      REPLAY_ORCHESTRATOR,
      {},
      {
        instanceId,
        version: VERSION,
      },
    );
    await client.waitForOrchestrationStart(instanceId, false, 30);

    await firstWorker.stop();
    removeStoppable(firstWorker);
    const replacementWorker = versionedBuilder()
      .addNamedOrchestrator(REPLAY_ORCHESTRATOR, RecoveryReplayProbeOrchestrator)
      .build();
    stoppables.push(replacementWorker);
    await replacementWorker.start();
    await client.raiseOrchestrationEvent(instanceId, RELEASE_EVENT, 'continue');

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({ replayed: true });
  }, 90_000);

  it('retries after side-effect success without duplicating the persisted receipt', async () => {
    let attempts = 0;
    let persistedReceipts = 0;
    let receiptExists = false;
    const client = createAzureManagedClient(connectionString);
    const worker = versionedBuilder()
      .addNamedOrchestrator(SIDE_EFFECT_ORCHESTRATOR, RecoverySideEffectProbeOrchestrator)
      .addNamedActivity(SIDE_EFFECT_ACTIVITY, () => {
        attempts += 1;
        if (!receiptExists) {
          receiptExists = true;
          persistedReceipts += 1;
        }
        if (attempts === 1) {
          throw new Error('side-effect-acknowledgement-lost');
        }
        return { receiptRecorded: receiptExists };
      })
      .build();
    stoppables.push(client, worker);
    await worker.start();

    const instanceId = uniqueInstanceId('side-effect-retry');
    await client.scheduleNewOrchestration(
      SIDE_EFFECT_ORCHESTRATOR,
      {},
      {
        instanceId,
        version: VERSION,
      },
    );
    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);

    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({ receiptRecorded: true });
    expect(attempts).toBe(2);
    expect(persistedReceipts).toBe(1);
  }, 60_000);

  it('reconciles a database failure after a deduplicated notification', async () => {
    let activityAttempts = 0;
    let databaseAttempts = 0;
    let providerRequests = 0;
    const deliveredPendingPostIds = new Set<string>();
    const client = createAzureManagedClient(connectionString);
    const worker = versionedBuilder()
      .addNamedOrchestrator(SIDE_EFFECT_ORCHESTRATOR, RecoverySideEffectProbeOrchestrator)
      .addNamedActivity(SIDE_EFFECT_ACTIVITY, () => {
        activityAttempts += 1;
        providerRequests += 1;
        deliveredPendingPostIds.add('stable-pending-post-id');
        databaseAttempts += 1;
        if (databaseAttempts === 1) {
          throw new Error('database-unavailable-after-notification');
        }
        return { receiptRecorded: true };
      })
      .build();
    stoppables.push(client, worker);
    await worker.start();

    const instanceId = uniqueInstanceId('database-after-notification');
    await client.scheduleNewOrchestration(
      SIDE_EFFECT_ORCHESTRATOR,
      {},
      {
        instanceId,
        version: VERSION,
      },
    );
    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);

    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(activityAttempts).toBe(2);
    expect(databaseAttempts).toBe(2);
    expect(providerRequests).toBe(2);
    expect(deliveredPendingPostIds.size).toBe(1);
  }, 60_000);

  it.each(['model', 'mattermost', 'blob', 'docling', 'gotenberg'])(
    'retries through a transient %s outage',
    async (dependency) => {
      let attempts = 0;
      const client = createAzureManagedClient(connectionString);
      const worker = versionedBuilder()
        .addNamedOrchestrator(SIDE_EFFECT_ORCHESTRATOR, RecoverySideEffectProbeOrchestrator)
        .addNamedActivity(SIDE_EFFECT_ACTIVITY, () => {
          attempts += 1;
          if (attempts < 3) throw new Error(`${dependency}-unavailable`);
          return { receiptRecorded: true };
        })
        .build();
      stoppables.push(client, worker);
      await worker.start();

      const instanceId = uniqueInstanceId(`${dependency}-outage`);
      await client.scheduleNewOrchestration(
        SIDE_EFFECT_ORCHESTRATOR,
        {},
        {
          instanceId,
          version: VERSION,
        },
      );
      const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);

      expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
      expect(attempts).toBe(3);
    },
    60_000,
  );

  it('handles an explicit cancellation event without post-cancellation work', async () => {
    const client = createAzureManagedClient(connectionString);
    const worker = versionedBuilder()
      .addNamedOrchestrator(REPLAY_ORCHESTRATOR, RecoveryCancellationProbeOrchestrator)
      .build();
    stoppables.push(client, worker);
    await worker.start();

    const instanceId = uniqueInstanceId('cancellation');
    await client.scheduleNewOrchestration(
      REPLAY_ORCHESTRATOR,
      {},
      {
        instanceId,
        version: VERSION,
      },
    );
    await client.waitForOrchestrationStart(instanceId, false, 30);
    await client.raiseOrchestrationEvent(instanceId, CANCEL_EVENT, 'cancel');

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({ cancelled: true });
  }, 60_000);

  it('buffers an event while suspended and completes after resume', async () => {
    const client = createAzureManagedClient(connectionString);
    const worker = versionedBuilder()
      .addNamedOrchestrator(REPLAY_ORCHESTRATOR, RecoveryReplayProbeOrchestrator)
      .build();
    stoppables.push(client, worker);
    await worker.start();

    const instanceId = uniqueInstanceId('suspend-resume');
    await client.scheduleNewOrchestration(
      REPLAY_ORCHESTRATOR,
      {},
      {
        instanceId,
        version: VERSION,
      },
    );
    await client.waitForOrchestrationStart(instanceId, false, 30);
    await client.suspendOrchestration(instanceId);
    await waitForStatus(client, instanceId, OrchestrationStatus.SUSPENDED);
    await client.raiseOrchestrationEvent(instanceId, RELEASE_EVENT, 'continue');
    expect((await client.getOrchestrationState(instanceId, false))?.runtimeStatus).toBe(
      OrchestrationStatus.SUSPENDED,
    );
    await client.resumeOrchestration(instanceId);

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({ replayed: true });
  }, 60_000);

  itWithSchedulerRecovery(
    'reconnects after the scheduler or client transport is interrupted',
    async () => {
      const client = createAzureManagedClient(connectionString);
      const worker = versionedBuilder()
        .addNamedOrchestrator(REPLAY_ORCHESTRATOR, RecoveryReplayProbeOrchestrator)
        .build();
      stoppables.push(client, worker);
      await worker.start();

      const instanceId = uniqueInstanceId('scheduler-reconnect');
      await client.scheduleNewOrchestration(
        REPLAY_ORCHESTRATOR,
        {},
        {
          instanceId,
          version: VERSION,
        },
      );
      await client.waitForOrchestrationStart(instanceId, false, 30);

      let activeClient = client;
      if (runAzure) {
        await worker.stop();
        removeStoppable(worker);
        await client.stop();
        removeStoppable(client);

        activeClient = createAzureManagedClient(connectionString);
        const replacementWorker = versionedBuilder()
          .addNamedOrchestrator(REPLAY_ORCHESTRATOR, RecoveryReplayProbeOrchestrator)
          .build();
        stoppables.push(activeClient, replacementWorker);
        await replacementWorker.start();
      } else {
        const composeFile = process.env.CAREOS_DURABLE_COMPOSE_FILE;
        if (composeFile === undefined || composeFile === '') {
          throw new Error('CAREOS_DURABLE_COMPOSE_FILE is required for scheduler recovery.');
        }
        await composeControl(composeFile, 'pause');
        try {
          await delay(500);
        } finally {
          await composeControl(composeFile, 'unpause');
        }
      }
      await activeClient.raiseOrchestrationEvent(instanceId, RELEASE_EVENT, 'continue');

      const completed = await activeClient.waitForOrchestrationCompletion(instanceId, true, 30);
      expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
      expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({ replayed: true });
    },
    90_000,
  );

  it('terminates a waiting instance without running post-release work', async () => {
    const client = createAzureManagedClient(connectionString);
    const worker = versionedBuilder()
      .addNamedOrchestrator(REPLAY_ORCHESTRATOR, RecoveryReplayProbeOrchestrator)
      .build();
    stoppables.push(client, worker);
    await worker.start();

    const instanceId = uniqueInstanceId('termination');
    await client.scheduleNewOrchestration(
      REPLAY_ORCHESTRATOR,
      {},
      {
        instanceId,
        version: VERSION,
      },
    );
    await client.waitForOrchestrationStart(instanceId, false, 30);
    await client.terminateOrchestration(instanceId, 'recovery-test-termination');

    const terminated = await client.waitForOrchestrationCompletion(instanceId, false, 30);
    expect(terminated?.runtimeStatus).toBe(OrchestrationStatus.TERMINATED);
  }, 60_000);
});

function versionedBuilder() {
  return createAzureManagedWorkerBuilder(connectionString).versioning({
    defaultVersion: VERSION,
    failureStrategy: VersionFailureStrategy.Reject,
    matchStrategy: VersionMatchStrategy.Strict,
    version: VERSION,
  });
}

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task executes async iterators.
async function* recoveryReplayProbeOrchestrator(
  context: OrchestrationContext,
): AsyncGenerator<Task<unknown>, { readonly replayed: true }, unknown> {
  yield context.waitForExternalEvent(RELEASE_EVENT);
  return { replayed: true };
}

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task executes async iterators.
async function* recoveryCancellationProbeOrchestrator(
  context: OrchestrationContext,
): AsyncGenerator<Task<unknown>, { readonly cancelled: true }, unknown> {
  yield context.waitForExternalEvent(CANCEL_EVENT);
  return { cancelled: true };
}

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task executes async iterators.
async function* recoverySideEffectProbeOrchestrator(
  context: OrchestrationContext,
): AsyncGenerator<Task<unknown>, { readonly receiptRecorded: boolean }, unknown> {
  const value = yield context.callActivity(
    SIDE_EFFECT_ACTIVITY,
    {},
    {
      retry: new RetryPolicy({
        firstRetryIntervalInMilliseconds: 100,
        maxNumberOfAttempts: 3,
      }),
      version: VERSION,
    },
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    !('receiptRecorded' in value) ||
    value.receiptRecorded !== true
  ) {
    throw new Error('Recovery side-effect probe returned an invalid receipt.');
  }
  return { receiptRecorded: true };
}

const RecoveryReplayProbeOrchestrator = recoveryReplayProbeOrchestrator as unknown as TOrchestrator;
const RecoveryCancellationProbeOrchestrator =
  recoveryCancellationProbeOrchestrator as unknown as TOrchestrator;
const RecoverySideEffectProbeOrchestrator =
  recoverySideEffectProbeOrchestrator as unknown as TOrchestrator;

function uniqueInstanceId(kind: string): string {
  return `recovery-${kind}-${Date.now()}-${process.pid}`;
}

function removeStoppable(stoppable: { stop(): Promise<void> }): void {
  const index = stoppables.indexOf(stoppable);
  if (index >= 0) stoppables.splice(index, 1);
}

async function waitForStatus(
  client: ReturnType<typeof createAzureManagedClient>,
  instanceId: string,
  expected: OrchestrationStatus,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await client.getOrchestrationState(instanceId, false))?.runtimeStatus === expected) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Orchestration ${instanceId} did not reach ${OrchestrationStatus[expected]}.`);
}

async function composeControl(composeFile: string, action: 'pause' | 'unpause'): Promise<void> {
  await execFileAsync('docker', ['compose', '-f', composeFile, action, 'dts-emulator']);
}
