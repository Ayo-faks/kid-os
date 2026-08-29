import {
  InMemoryOrchestrationBackend,
  OrchestrationStatus,
  TestOrchestrationClient,
  TestOrchestrationWorker,
} from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DOCUMENT_INGEST_ORCHESTRATOR,
  type DocumentIngestOrchestratorInput,
  PROCESS_DOCUMENT_INGEST_ACTIVITY,
  documentIngestInstanceId,
} from './document-ingest.contracts.js';
import { DocumentIngestOrchestrator } from './orchestrators/document-ingest.orchestrator.js';

const input: DocumentIngestOrchestratorInput = {
  actor: {
    correlationId: 'corr-document',
    kind: 'user',
    userId: '33333333-3333-4333-8333-333333333333',
  },
  documentId: '44444444-4444-4444-8444-444444444444',
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const workers: TestOrchestrationWorker[] = [];
const clients: TestOrchestrationClient[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe('Durable Document Ingest orchestration', () => {
  it('completes with an ID-only extracted result', async () => {
    const runtime = documentRuntime({ documentId: input.documentId, status: 'extracted' });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      documentId: input.documentId,
      status: 'extracted',
    });
    expect(state?.serializedCustomStatus).toBe(state?.serializedOutput);
  });

  it('completes truthfully when Docling is unavailable', async () => {
    const runtime = documentRuntime({
      documentId: input.documentId,
      outcomeCode: 'docling-unavailable',
      status: 'failed',
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(JSON.parse(state?.serializedOutput ?? '{}')).toEqual({
      documentId: input.documentId,
      outcomeCode: 'docling-unavailable',
      status: 'failed',
    });
  });

  it('rejects an activity result that attempts to place extracted text in history', async () => {
    const runtime = documentRuntime({
      documentId: input.documentId,
      extractedText: '# Resident care plan',
      status: 'extracted',
    });
    await runtime.worker.start();

    const state = await run(runtime);

    expect(state?.runtimeStatus).toBe(OrchestrationStatus.FAILED);
  });
});

function documentRuntime(result: unknown) {
  const backend = new InMemoryOrchestrationBackend();
  const worker = new TestOrchestrationWorker(backend);
  const client = new TestOrchestrationClient(backend);
  worker.addNamedOrchestrator(DOCUMENT_INGEST_ORCHESTRATOR, DocumentIngestOrchestrator);
  worker.addNamedActivity(PROCESS_DOCUMENT_INGEST_ACTIVITY, () => result);
  workers.push(worker);
  clients.push(client);
  return { client, worker };
}

async function run(runtime: ReturnType<typeof documentRuntime>) {
  const instanceId = documentIngestInstanceId(input.documentId);
  await runtime.client.scheduleNewOrchestration(DOCUMENT_INGEST_ORCHESTRATOR, input, instanceId);
  return runtime.client.waitForOrchestrationCompletion(instanceId, true, 5);
}
