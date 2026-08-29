import { OrchestrationStatus } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clientMock = vi.hoisted(() => ({
  getOrchestrationState: vi.fn(),
  raiseOrchestrationEvent: vi.fn(),
  stop: vi.fn(),
}));
const createClientMock = vi.hoisted(() => vi.fn(() => clientMock));

vi.mock('@microsoft/durabletask-js-azuremanaged', () => ({
  createAzureManagedClient: createClientMock,
}));

import { DurableApprovalEventClient } from './durable-approval-event.client.js';

const instanceId = 'approval-33333333-3333-4333-8333-333333333333';
const commandId = '88888888-8888-4888-8888-888888888888';

describe('DurableApprovalEventClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('raises only the opaque command id for a running approval', async () => {
    vi.stubEnv(
      'DURABLE_TASK_SCHEDULER_CONNECTION_STRING',
      'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
    );
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.RUNNING,
    });
    clientMock.raiseOrchestrationEvent.mockResolvedValue(undefined);
    const client = new DurableApprovalEventClient();

    await client.raiseDecision(instanceId, commandId);

    expect(clientMock.raiseOrchestrationEvent).toHaveBeenCalledWith(
      instanceId,
      'approvalDecision',
      { commandId },
    );
    await client.onModuleDestroy();
    expect(clientMock.stop).toHaveBeenCalledOnce();
  });

  it('fails closed when Durable Task is not configured', async () => {
    vi.stubEnv('DURABLE_TASK_SCHEDULER_CONNECTION_STRING', '');
    const client = new DurableApprovalEventClient();

    await expect(client.raiseDecision(instanceId, commandId)).rejects.toThrow(/not configured/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('rejects missing and terminal workflow instances', async () => {
    vi.stubEnv(
      'DURABLE_TASK_SCHEDULER_CONNECTION_STRING',
      'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
    );
    const missing = new DurableApprovalEventClient();
    clientMock.getOrchestrationState.mockResolvedValueOnce(undefined);
    await expect(missing.raiseDecision(instanceId, commandId)).rejects.toThrow(/not found/);

    const terminal = new DurableApprovalEventClient();
    clientMock.getOrchestrationState.mockResolvedValueOnce({
      runtimeStatus: OrchestrationStatus.COMPLETED,
    });
    await expect(terminal.raiseDecision(instanceId, commandId)).rejects.toThrow(/terminal/);
    expect(clientMock.raiseOrchestrationEvent).not.toHaveBeenCalled();
  });
});
