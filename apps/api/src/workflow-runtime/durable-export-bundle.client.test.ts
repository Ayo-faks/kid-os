import type { SeriousIncidentExportWorkflowInput } from '@careos/contracts';
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

import { DurableExportBundleClient } from './durable-export-bundle.client.js';

const bundleId = '44444444-4444-4444-8444-444444444444';
const instanceId = `serious-incident-export-${bundleId}`;
const input: SeriousIncidentExportWorkflowInput = {
  actor: {
    correlationId: 'corr-export',
    kind: 'user',
    userId: '55555555-5555-4555-8555-555555555555',
  },
  bundleId,
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('DurableExportBundleClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('starts the versioned ID-only export orchestration', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue(undefined);
    clientMock.scheduleNewOrchestration.mockResolvedValue(instanceId);

    await new DurableExportBundleClient().start(instanceId, input);

    expect(clientMock.scheduleNewOrchestration).toHaveBeenCalledWith(
      'SeriousIncidentExportOrchestratorV1',
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

    await expect(new DurableExportBundleClient().start(instanceId, input)).resolves.toBeUndefined();
  });

  it('rejects reuse of a terminal export instance', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.COMPLETED,
    });

    await expect(new DurableExportBundleClient().start(instanceId, input)).rejects.toThrow(
      /terminal/,
    );
  });

  it('fails closed without scheduler configuration', async () => {
    vi.stubEnv('DURABLE_TASK_SCHEDULER_CONNECTION_STRING', '');

    await expect(new DurableExportBundleClient().start(instanceId, input)).rejects.toThrow(
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
