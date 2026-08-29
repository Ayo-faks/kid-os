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
  FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY,
  INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION,
  INCIDENT_FOLLOW_UP_ORCHESTRATOR,
  PROCESS_INCIDENT_FOLLOW_UP_ACTIVITY,
} from './incident-follow-up.contracts.js';
import { IncidentFollowUpActionOrchestrator } from './orchestrators/incident-follow-up.orchestrator.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Incident Follow-up emulator integration', () => {
  it('persists an ID-only completed export follow-up through the DTS emulator', async () => {
    const actionId = uuidFromClock();
    const targetId = '55555555-5555-4555-8555-555555555555';
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(INCIDENT_FOLLOW_UP_ORCHESTRATOR, IncidentFollowUpActionOrchestrator)
      .addNamedActivity(PROCESS_INCIDENT_FOLLOW_UP_ACTIVITY, () => ({
        kind: 'terminal',
        status: 'completed',
      }))
      .addNamedActivity(FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY, () => undefined)
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = `incident-follow-up-${actionId}-attempt-1`;
    await client.scheduleNewOrchestration(
      INCIDENT_FOLLOW_UP_ORCHESTRATOR,
      {
        actionId,
        attempt: 1,
        correlationId: `emulator-follow-up-${actionId}`,
        homeId: '22222222-2222-4222-8222-222222222222',
        incidentId: '33333333-3333-4333-8333-333333333333',
        kind: 'export_bundle',
        requestedByUserId: '44444444-4444-4444-8444-444444444444',
        targetId,
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      { instanceId, version: INCIDENT_FOLLOW_UP_ORCHESTRATION_VERSION },
    );

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({
      actionId,
      status: 'completed',
      targetId,
    });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `94949494-9494-4494-8949-${digits}`;
}
