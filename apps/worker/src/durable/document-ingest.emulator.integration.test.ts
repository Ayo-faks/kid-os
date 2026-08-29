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
  DOCUMENT_INGEST_ORCHESTRATION_VERSION,
  DOCUMENT_INGEST_ORCHESTRATOR,
  PROCESS_DOCUMENT_INGEST_ACTIVITY,
  documentIngestInstanceId,
} from './document-ingest.contracts.js';
import { DocumentIngestOrchestrator } from './orchestrators/document-ingest.orchestrator.js';

const runEmulator = process.env.CAREOS_RUN_DURABLE_EMULATOR === 'true';
const describeEmulator = runEmulator ? describe : describe.skip;
const connectionString =
  process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING ??
  'Endpoint=http://127.0.0.1:8080;Authentication=None;TaskHub=default';
const stoppables: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(stoppables.splice(0).map((item) => item.stop()));
});

describeEmulator('Durable Document Ingest emulator integration', () => {
  it('persists an ID-only terminal result through the DTS emulator', async () => {
    const documentId = uuidFromClock();
    const client = createAzureManagedClient(connectionString);
    const worker = createAzureManagedWorkerBuilder(connectionString)
      .versioning({
        defaultVersion: DOCUMENT_INGEST_ORCHESTRATION_VERSION,
        failureStrategy: VersionFailureStrategy.Reject,
        matchStrategy: VersionMatchStrategy.Strict,
        version: DOCUMENT_INGEST_ORCHESTRATION_VERSION,
      })
      .addNamedOrchestrator(DOCUMENT_INGEST_ORCHESTRATOR, DocumentIngestOrchestrator)
      .addNamedActivity(PROCESS_DOCUMENT_INGEST_ACTIVITY, () => ({
        documentId,
        status: 'extracted',
      }))
      .build();
    stoppables.push(worker, client);
    await worker.start();

    const instanceId = documentIngestInstanceId(documentId);
    await client.scheduleNewOrchestration(
      DOCUMENT_INGEST_ORCHESTRATOR,
      {
        actor: {
          correlationId: `emulator-document-${documentId}`,
          kind: 'user',
          userId: '33333333-3333-4333-8333-333333333333',
        },
        documentId,
        homeId: '22222222-2222-4222-8222-222222222222',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      { instanceId, version: DOCUMENT_INGEST_ORCHESTRATION_VERSION },
    );

    const completed = await client.waitForOrchestrationCompletion(instanceId, true, 30);
    expect(completed?.runtimeStatus).toBe(OrchestrationStatus.COMPLETED);
    expect(JSON.parse(completed?.serializedOutput ?? '{}')).toEqual({
      documentId,
      status: 'extracted',
    });
  }, 60_000);
});

function uuidFromClock(): string {
  const digits = `${Date.now()}${process.pid}`.slice(-12).padStart(12, '0');
  return `98989898-9898-4898-8989-${digits}`;
}
