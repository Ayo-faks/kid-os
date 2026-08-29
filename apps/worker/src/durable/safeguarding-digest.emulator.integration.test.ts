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

import { createStartSafeguardingDigestDeliveryActivity } from './activities/safeguarding-digest.activities.js';
import {
  SafeguardingDigestSweepOrchestrator,
  SendSafeguardingDigestOrchestrator,
} from './orchestrators/safeguarding-digest.orchestrators.js';
import {
  FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY,
  PROCESS_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
  SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
  SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
  SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR,
  START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
  safeguardingDigestDeliveryInstanceId,
} from './safeguarding-digest.contracts.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Safeguarding Digest emulator integration', () => {
  it('starts and completes an aggregate-only detached delivery through DTS', async () => {
    const homeId = uuidFromClock();
    const target = {
      homeId,
      tenantId: '11111111-1111-4111-8111-111111111111',
    };
    const nowIso = '2026-07-20T07:00:00.000Z';
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(
        SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
        SafeguardingDigestSweepOrchestrator,
      )
      .addNamedOrchestrator(
        SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR,
        SendSafeguardingDigestOrchestrator,
      )
      .addNamedActivity(FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY, () => ({ targets: [target] }))
      .addNamedActivity(
        START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
        createStartSafeguardingDigestDeliveryActivity({
          getOrchestrationState: (instanceId, fetchPayloads) =>
            client.getOrchestrationState(instanceId, fetchPayloads),
          scheduleNewOrchestration: (orchestrator, input, options) =>
            client.scheduleNewOrchestration(orchestrator, input, options),
        }),
      )
      .addNamedActivity(PROCESS_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY, () => ({
        dispatched: true,
      }))
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const sweepId = `safeguarding-digest-sweep:emulator-${String(Date.now())}`;
    await client.scheduleNewOrchestration(
      SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
      {
        correlationId: sweepId,
        nowIso,
        sinceIso: '2026-07-13T07:00:00.000Z',
      },
      { instanceId: sweepId, version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION },
    );

    const sweep = await client.waitForOrchestrationCompletion(sweepId, true, 30);
    const delivery = await client.waitForOrchestrationCompletion(
      safeguardingDigestDeliveryInstanceId(homeId, nowIso),
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
  return `99999999-9999-4999-8999-${digits}`;
}
