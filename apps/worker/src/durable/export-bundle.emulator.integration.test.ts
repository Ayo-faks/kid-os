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
  EXPORT_BUNDLE_ORCHESTRATION_VERSION,
  PROCESS_EXPORT_BUNDLE_ACTIVITY,
  SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR,
  exportBundleInstanceId,
} from './export-bundle.contracts.js';
import { SeriousIncidentExportOrchestrator } from './orchestrators/export-bundle.orchestrator.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Serious Incident Export emulator integration', () => {
  it('persists an ID-only ready result through the DTS emulator', async () => {
    const bundleId = uuidFromClock();
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: EXPORT_BUNDLE_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: EXPORT_BUNDLE_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR, SeriousIncidentExportOrchestrator)
      .addNamedActivity(PROCESS_EXPORT_BUNDLE_ACTIVITY, () => ({
        bundleId,
        status: 'ready',
      }))
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = exportBundleInstanceId(bundleId);
    await client.scheduleNewOrchestration(
      SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR,
      {
        actor: {
          correlationId: `emulator-export-${bundleId}`,
          kind: 'user',
          userId: '55555555-5555-4555-8555-555555555555',
        },
        bundleId,
        homeId: '22222222-2222-4222-8222-222222222222',
        incidentId: '33333333-3333-4333-8333-333333333333',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      { instanceId, version: EXPORT_BUNDLE_ORCHESTRATION_VERSION },
    );

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({
      bundleId,
      status: 'ready',
    });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `97979797-9797-4797-8979-${digits}`;
}
