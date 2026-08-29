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
  EMAIL_DRAFT_ORCHESTRATION_VERSION,
  EMAIL_DRAFT_ORCHESTRATOR,
  FINALIZE_EMAIL_DRAFT_FAILURE_ACTIVITY,
  PROCESS_EMAIL_DRAFT_COMMAND_ACTIVITY,
  START_EMAIL_DRAFT_APPROVAL_ACTIVITY,
  emailDraftInstanceId,
} from './email-draft.contracts.js';
import { EmailDraftOrchestrator } from './orchestrators/email-draft.orchestrator.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Email Draft emulator integration', () => {
  it('persists an ID-only routine draft result through the DTS emulator', async () => {
    const emailDraftId = uuidFromClock();
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: EMAIL_DRAFT_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: EMAIL_DRAFT_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(EMAIL_DRAFT_ORCHESTRATOR, EmailDraftOrchestrator)
      .addNamedActivity(PROCESS_EMAIL_DRAFT_COMMAND_ACTIVITY, () => ({
        kind: 'state',
        state: {
          emailDraftId,
          missingMandatory: [],
          sensitivity: 'routine',
          status: 'draft',
        },
      }))
      .addNamedActivity(START_EMAIL_DRAFT_APPROVAL_ACTIVITY, () => 'approval-not-required')
      .addNamedActivity(FINALIZE_EMAIL_DRAFT_FAILURE_ACTIVITY, () => undefined)
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = emailDraftInstanceId(emailDraftId);
    await client.scheduleNewOrchestration(
      EMAIL_DRAFT_ORCHESTRATOR,
      {
        actor: {
          correlationId: `emulator-email-${emailDraftId}`,
          kind: 'user',
          userId: '55555555-5555-4555-8555-555555555555',
        },
        authorUserId: '55555555-5555-4555-8555-555555555555',
        commandId: '66666666-6666-4666-8666-666666666666',
        emailDraftId,
        homeId: '22222222-2222-4222-8222-222222222222',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      { instanceId, version: EMAIL_DRAFT_ORCHESTRATION_VERSION },
    );

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toMatchObject({
      emailDraftId,
      sensitivity: 'routine',
      status: 'draft',
    });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `95959595-9595-4595-8959-${digits}`;
}
