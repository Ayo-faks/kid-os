import type { RetentionSweepDurableWorkflowInput } from '@careos/contracts';
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

import { DurableRetentionClient } from './durable-retention.client.js';

const sweepId = '44444444-4444-4444-8444-444444444444';
const instanceId = `retention-sweep-${sweepId}`;
const input: RetentionSweepDurableWorkflowInput = {
  correlationId: 'corr-retention',
  nowIso: '2026-07-18T01:00:00.000Z',
  owner: {
    homeId: '22222222-2222-4222-8222-222222222222',
    tenantId: '11111111-1111-4111-8111-111111111111',
    workflowInstanceId: '99999999-9999-4999-8999-999999999999',
  },
  sweepId,
};

describe('DurableRetentionClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('starts a versioned aggregate-only sweep', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue(undefined);
    clientMock.scheduleNewOrchestration.mockResolvedValue(instanceId);

    await new DurableRetentionClient().start(instanceId, input);

    expect(clientMock.scheduleNewOrchestration).toHaveBeenCalledWith(
      'RetentionSweepOrchestratorV1',
      input,
      { instanceId, version: '1.0.0' },
    );
  });

  it('reuses an active instance and reconciles a concurrent start', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.RUNNING,
    });
    await new DurableRetentionClient().start(instanceId, input);
    expect(clientMock.scheduleNewOrchestration).not.toHaveBeenCalled();

    vi.clearAllMocks();
    clientMock.getOrchestrationState
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ runtimeStatus: OrchestrationStatus.RUNNING });
    clientMock.scheduleNewOrchestration.mockRejectedValue(new Error('response lost'));
    await expect(new DurableRetentionClient().start(instanceId, input)).resolves.toBeUndefined();
  });

  it('fails closed for terminal history or missing configuration', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.FAILED,
    });
    await expect(new DurableRetentionClient().start(instanceId, input)).rejects.toThrow(
      /already terminal/,
    );

    vi.clearAllMocks();
    vi.stubEnv('DURABLE_TASK_SCHEDULER_CONNECTION_STRING', '');
    await expect(new DurableRetentionClient().start(instanceId, input)).rejects.toThrow(
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
