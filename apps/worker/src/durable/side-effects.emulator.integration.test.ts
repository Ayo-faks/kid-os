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
const ORCHESTRATOR = 'SideEffectRetryProbeOrchestrator';
const ACTIVITY = 'sideEffectRetryProbeActivity';
const stoppables: Array<{ stop(): Promise<void> }> = [];

const effectClasses = [
  'database',
  'audit',
  'outbox',
  'mattermost',
  'minio',
  'hermes',
  'docling',
  'gotenberg',
] as const;

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable at-least-once side-effect safety', () => {
  it.each(effectClasses)(
    'reconciles %s success when the first activity acknowledgement is lost',
    async (effectClass) => {
      let attempts = 0;
      let appliedEffects = 0;
      const receipts = new Set<string>();
      const client = createAzureManagedClient(connectionString);
      const worker = createAzureManagedWorkerBuilder(connectionString)
        .versioning({
          defaultVersion: VERSION,
          failureStrategy: VersionFailureStrategy.Reject,
          matchStrategy: VersionMatchStrategy.Strict,
          version: VERSION,
        })
        .addNamedOrchestrator(ORCHESTRATOR, SideEffectRetryProbeOrchestrator)
        .addNamedActivity(ACTIVITY, () => {
          attempts += 1;
          if (!receipts.has(effectClass)) {
            receipts.add(effectClass);
            appliedEffects += 1;
          }
          if (attempts === 1) throw new Error(`${effectClass}-acknowledgement-lost`);
          return { receiptRecorded: true };
        })
        .build();
      stoppables.push(client, worker);
      await worker.start();

      const instanceId = `side-effect-${effectClass}-${Date.now()}-${process.pid}`;
      await client.scheduleNewOrchestration(
        ORCHESTRATOR,
        {},
        {
          instanceId,
          version: VERSION,
        },
      );
      const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);

      expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
      expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({
        receiptRecorded: true,
      });
      expect(attempts).toBe(2);
      expect(appliedEffects).toBe(1);
      expect(receipts).toEqual(new Set([effectClass]));
    },
    60_000,
  );
});

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task executes async iterators.
async function* sideEffectRetryProbeOrchestrator(
  context: OrchestrationContext,
): AsyncGenerator<Task<unknown>, { readonly receiptRecorded: true }, unknown> {
  const value = yield context.callActivity(
    ACTIVITY,
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
    throw new Error('Side-effect retry probe returned an invalid receipt.');
  }
  return { receiptRecorded: true };
}

const SideEffectRetryProbeOrchestrator =
  sideEffectRetryProbeOrchestrator as unknown as TOrchestrator;
