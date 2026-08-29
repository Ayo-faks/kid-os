import type { DocIngestWorkflowInput } from '@careos/contracts';
import { OrchestrationStatus } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clientMock = vi.hoisted(() => ({
  getOrchestrationState: vi.fn(),
  scheduleNewOrchestration: vi.fn(),
  stop: vi.fn(),
}));
const createClientMock = vi.hoisted(() => vi.fn(() => clientMock));

vi.mock('@microsoft/durabletask-js-azuremanaged', () => ({
  createAzureManagedClient: createClientMock,
}));

import { DurableDocumentClient } from './durable-document.client.js';

const documentId = '44444444-4444-4444-8444-444444444444';
const instanceId = `doc-ingest-${documentId}`;
const input: DocIngestWorkflowInput = {
  actor: {
    correlationId: 'corr-document',
    kind: 'user',
    userId: '33333333-3333-4333-8333-333333333333',
  },
  documentId,
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('DurableDocumentClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('starts the versioned ID-only document orchestration', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue(undefined);
    clientMock.scheduleNewOrchestration.mockResolvedValue(instanceId);

    await new DurableDocumentClient().start(instanceId, input);

    expect(clientMock.scheduleNewOrchestration).toHaveBeenCalledWith(
      'DocumentIngestOrchestratorV1',
      input,
      { instanceId, version: '1.0.0' },
    );
  });

  it('reconciles another caller winning the start race', async () => {
    configure();
    clientMock.getOrchestrationState
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ runtimeStatus: OrchestrationStatus.RUNNING });
    clientMock.scheduleNewOrchestration.mockRejectedValue(new Error('already exists'));

    await expect(new DurableDocumentClient().start(instanceId, input)).resolves.toBeUndefined();
  });

  it('rejects reuse of a terminal document instance', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.COMPLETED,
    });

    await expect(new DurableDocumentClient().start(instanceId, input)).rejects.toThrow(/terminal/);
  });

  it('fails closed without scheduler configuration', async () => {
    vi.stubEnv('DURABLE_TASK_SCHEDULER_CONNECTION_STRING', '');

    await expect(new DurableDocumentClient().start(instanceId, input)).rejects.toThrow(
      /not configured/,
    );
  });
});

function configure(): void {
  vi.stubEnv(
    'DURABLE_TASK_SCHEDULER_CONNECTION_STRING',
    'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
  );
}
