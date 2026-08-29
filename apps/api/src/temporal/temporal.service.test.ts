import { type DocIngestWorkflowInput } from '@careos/contracts';
import { type Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';

import { TemporalService } from './temporal.service.js';

const input: DocIngestWorkflowInput = {
  actor: {
    correlationId: 'corr-document-ingest',
    kind: 'user',
    userId: '33333333-3333-4333-8333-333333333333',
  },
  documentId: '44444444-4444-4444-8444-444444444444',
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

function harness(options?: { readonly duplicate?: boolean }) {
  const describeExecution = vi.fn().mockResolvedValue({ runId: 'existing-run' });
  const getHandle = vi.fn().mockReturnValue({ describe: describeExecution });
  const start = options?.duplicate
    ? vi
        .fn()
        .mockRejectedValue(
          new WorkflowExecutionAlreadyStartedError(
            'workflow already exists',
            'doc-ingest-44444444-4444-4444-8444-444444444444',
            'DocIngestWorkflow',
          ),
        )
    : vi.fn().mockResolvedValue({
        firstExecutionRunId: 'new-run',
        workflowId: 'doc-ingest-44444444-4444-4444-8444-444444444444',
      });
  const client = { workflow: { getHandle, start } };
  const service = new TemporalService();
  Object.defineProperty(service, 'clientPromise', {
    value: Promise.resolve(client as unknown as Client),
    writable: true,
  });
  return { describeExecution, getHandle, service, start };
}

describe('TemporalService document ingestion', () => {
  it('rejects closed-run reuse while reusing an active execution', async () => {
    const { getHandle, service, start } = harness();

    await expect(service.startDocIngestWorkflow(input)).resolves.toEqual({
      documentId: input.documentId,
      runId: 'new-run',
      taskQueue: 'careos.documents',
      workflowId: 'doc-ingest-44444444-4444-4444-8444-444444444444',
    });
    expect(start).toHaveBeenCalledWith(
      'DocIngestWorkflow',
      expect.objectContaining({
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
      }),
    );
    expect(getHandle).not.toHaveBeenCalled();
  });

  it('returns the existing run identity after a closed-run retry', async () => {
    const { describeExecution, getHandle, service } = harness({ duplicate: true });

    await expect(service.startDocIngestWorkflow(input)).resolves.toEqual({
      documentId: input.documentId,
      runId: 'existing-run',
      taskQueue: 'careos.documents',
      workflowId: 'doc-ingest-44444444-4444-4444-8444-444444444444',
    });
    expect(getHandle).toHaveBeenCalledWith('doc-ingest-44444444-4444-4444-8444-444444444444');
    expect(describeExecution).toHaveBeenCalledOnce();
  });
});
