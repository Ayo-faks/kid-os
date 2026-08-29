import type { RotaPublishDurableWorkflowInput } from '@careos/contracts';
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

import { DurableRotaPublishClient } from './durable-rota-publish.client.js';

const publicationId = '44444444-4444-4444-8444-444444444444';
const instanceId = `rota-publish-${publicationId}`;
const input: RotaPublishDurableWorkflowInput = {
  actor: {
    correlationId: 'corr-rota-publish',
    kind: 'user',
    userId: '55555555-5555-4555-8555-555555555555',
  },
  commandId: '66666666-6666-4666-8666-666666666666',
  homeId: '22222222-2222-4222-8222-222222222222',
  publicationId,
  publishedByUserId: '55555555-5555-4555-8555-555555555555',
  shiftIds: ['33333333-3333-4333-8333-333333333333'],
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('DurableRotaPublishClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('starts the versioned ID-only Rota Publish orchestration', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue(undefined);
    clientMock.scheduleNewOrchestration.mockResolvedValue(instanceId);

    await new DurableRotaPublishClient().start(instanceId, input);

    expect(clientMock.scheduleNewOrchestration).toHaveBeenCalledWith(
      'RotaPublishOrchestratorV1',
      input,
      { instanceId, version: '1.0.0' },
    );
    expect(JSON.stringify(clientMock.scheduleNewOrchestration.mock.calls[0])).not.toContain('note');
  });

  it('reconciles another caller winning the start race', async () => {
    configure();
    clientMock.getOrchestrationState
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ runtimeStatus: OrchestrationStatus.RUNNING });
    clientMock.scheduleNewOrchestration.mockRejectedValue(new Error('already exists'));

    await expect(new DurableRotaPublishClient().start(instanceId, input)).resolves.toBeUndefined();
  });

  it('rejects reuse of a terminal Rota Publish instance', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.COMPLETED,
    });

    await expect(new DurableRotaPublishClient().start(instanceId, input)).rejects.toThrow(
      /terminal/,
    );
  });

  it('fails closed without scheduler configuration', async () => {
    vi.stubEnv('DURABLE_TASK_SCHEDULER_CONNECTION_STRING', '');

    await expect(new DurableRotaPublishClient().start(instanceId, input)).rejects.toThrow(
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
