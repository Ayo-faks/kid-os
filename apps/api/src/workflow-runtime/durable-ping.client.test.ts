import type { PingDurableWorkflowInput } from '@careos/contracts';
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

import { DurablePingClient } from './durable-ping.client.js';

const pingId = '44444444-4444-4444-8444-444444444444';
const instanceId = `phase0-ping-${pingId}`;
const input: PingDurableWorkflowInput = {
  commandId: '66666666-6666-4666-8666-666666666666',
  correlationId: 'corr-ping',
  pingId,
};

describe('DurablePingClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('starts a versioned ID-only Ping', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue(undefined);
    clientMock.scheduleNewOrchestration.mockResolvedValue(instanceId);

    await new DurablePingClient().start(instanceId, input);

    expect(clientMock.scheduleNewOrchestration).toHaveBeenCalledWith('PingOrchestratorV1', input, {
      instanceId,
      version: '1.0.0',
    });
  });

  it('reuses active ownership and reconciles a concurrent start', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.RUNNING,
    });
    await new DurablePingClient().start(instanceId, input);
    expect(clientMock.scheduleNewOrchestration).not.toHaveBeenCalled();

    vi.clearAllMocks();
    clientMock.getOrchestrationState
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ runtimeStatus: OrchestrationStatus.RUNNING });
    clientMock.scheduleNewOrchestration.mockRejectedValue(new Error('response lost'));
    await expect(new DurablePingClient().start(instanceId, input)).resolves.toBeUndefined();
  });

  it('fails closed for terminal history and missing configuration', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.FAILED,
    });
    await expect(new DurablePingClient().start(instanceId, input)).rejects.toThrow(
      /already terminal/,
    );

    vi.clearAllMocks();
    vi.stubEnv('DURABLE_TASK_SCHEDULER_CONNECTION_STRING', '');
    await expect(new DurablePingClient().start(instanceId, input)).rejects.toThrow(
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
