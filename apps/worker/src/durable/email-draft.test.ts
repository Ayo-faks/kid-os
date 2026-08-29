import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EMAIL_DRAFT_ORCHESTRATOR,
  type EmailDraftOrchestratorInput,
  FINALIZE_EMAIL_DRAFT_FAILURE_ACTIVITY,
  PROCESS_EMAIL_DRAFT_COMMAND_ACTIVITY,
  START_EMAIL_DRAFT_APPROVAL_ACTIVITY,
  emailDraftInstanceId,
} from './email-draft.contracts.js';
import { EmailDraftOrchestrator } from './orchestrators/email-draft.orchestrator.js';

const input: EmailDraftOrchestratorInput = {
  actor: {
    correlationId: 'corr-email',
    kind: 'user',
    userId: '55555555-5555-4555-8555-555555555555',
  },
  authorUserId: '55555555-5555-4555-8555-555555555555',
  commandId: '66666666-6666-4666-8666-666666666666',
  emailDraftId: '44444444-4444-4444-8444-444444444444',
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Email Draft orchestration', () => {
  it('completes a routine draft without starting Approval', async () => {
    const runtime = emailRuntime({
      kind: 'state',
      state: routineState(),
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual(routineState());
    expect(runtime.startedApprovals).toEqual([]);
  });

  it('starts sensitive Approval as an ID-only detached root', async () => {
    const runtime = emailRuntime({
      approval: approvalInput(),
      kind: 'await_approval',
      state: {
        emailDraftId: input.emailDraftId,
        missingMandatory: [],
        sensitivity: 'sensitive',
        status: 'needs_review',
      },
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(runtime.startedApprovals).toEqual([approvalInput()]);
    expect(JSON.stringify(runtime.startedApprovals)).not.toContain('Safeguarding review');
    expect(JSON.stringify(runtime.startedApprovals)).not.toContain('safeguarding email body');
  });

  it('fails truthfully when the draft is refused', async () => {
    const runtime = emailRuntime({
      kind: 'state',
      state: {
        emailDraftId: input.emailDraftId,
        missingMandatory: ['subject', 'body'],
        outcomeCode: 'refused',
        sensitivity: 'sensitive',
        status: 'failed',
      },
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(JSON.parse(state?.serializedCustomStatus ?? '{}')).toMatchObject({
      outcomeCode: 'refused',
      status: 'failed',
    });
    expect(runtime.finalizations).toEqual([]);
  });

  it('finalizes a malformed activity result before failing generically', async () => {
    const runtime = emailRuntime({
      body: 'private body',
      kind: 'state',
      state: routineState(),
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
    expect(runtime.finalizations).toEqual([
      expect.objectContaining({ emailDraftId: input.emailDraftId }),
    ]);
  });

  it('rejects scheduler input containing instructions', async () => {
    const runtime = emailRuntime({ kind: 'state', state: routineState() });
    await runtime.worker.start();
    const instanceId = emailDraftInstanceId(input.emailDraftId);
    await runtime.client.scheduleNewOrchestration(
      EMAIL_DRAFT_ORCHESTRATOR,
      { ...input, instructions: 'Draft private email content.' },
      instanceId,
    );

    const state = await runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });
});

function emailRuntime(result: unknown) {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  const finalizations: unknown[] = [];
  const startedApprovals: unknown[] = [];
  worker.addNamedOrchestrator(EMAIL_DRAFT_ORCHESTRATOR, EmailDraftOrchestrator);
  worker.addNamedActivity(PROCESS_EMAIL_DRAFT_COMMAND_ACTIVITY, () => result);
  worker.addNamedActivity(START_EMAIL_DRAFT_APPROVAL_ACTIVITY, (_context, value: unknown) => {
    startedApprovals.push(value);
    return `approval-${input.emailDraftId}`;
  });
  worker.addNamedActivity(FINALIZE_EMAIL_DRAFT_FAILURE_ACTIVITY, (_context, value: unknown) => {
    finalizations.push(value);
  });
  workers.push(worker);
  clients.push(client);
  return { client, finalizations, startedApprovals, worker };
}

async function run(runtime: ReturnType<typeof emailRuntime>) {
  const instanceId = emailDraftInstanceId(input.emailDraftId);
  await runtime.client.scheduleNewOrchestration(EMAIL_DRAFT_ORCHESTRATOR, input, instanceId);
  return runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
}

function routineState() {
  return {
    emailDraftId: input.emailDraftId,
    missingMandatory: [],
    sensitivity: 'routine' as const,
    status: 'draft' as const,
  };
}

function approvalInput() {
  return {
    actor: input.actor,
    approvalId: input.emailDraftId,
    homeId: input.homeId,
    requestedByUserId: input.authorUserId,
    requiredRoles: ['manager', 'safeguarding_lead'],
    signaturesRequired: 2,
    subjectId: input.emailDraftId,
    subjectType: 'email_draft',
    tenantId: input.tenantId,
  } as const;
}
