import type { RotaAnalyzeDurableWorkflowInput } from '@careos/contracts';
import { OrchestrationStatus } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clientMock = vi.hoisted(() => ({
  getOrchestrationState: vi.fn(),
  scheduleNewOrchestration: vi.fn(),
  stop: vi.fn(),
  waitForOrchestrationCompletion: vi.fn(),
}));
const createClientMock = vi.hoisted(() => vi.fn(() => clientMock));

vi.mock('@microsoft/durabletask-js-azuremanaged', () => ({
  createAzureManagedClient: createClientMock,
}));

import { DurableRotaAnalyzeClient } from './durable-rota-analyze.client.js';

const analysisId = '44444444-4444-4444-8444-444444444444';
const instanceId = `rota-analyze-${analysisId}`;
const input: RotaAnalyzeDurableWorkflowInput = {
  actor: {
    correlationId: 'corr-rota-analyze',
    kind: 'user',
    userId: '55555555-5555-4555-8555-555555555555',
  },
  analysisId,
  commandId: '66666666-6666-4666-8666-666666666666',
  homeId: '22222222-2222-4222-8222-222222222222',
  requestedByUserId: '55555555-5555-4555-8555-555555555555',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('DurableRotaAnalyzeClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('starts a versioned ID-only analysis and waits without fetching payloads', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue(undefined);
    clientMock.scheduleNewOrchestration.mockResolvedValue(instanceId);
    clientMock.waitForOrchestrationCompletion.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.COMPLETED,
    });

    await new DurableRotaAnalyzeClient().execute(instanceId, input);

    expect(clientMock.scheduleNewOrchestration).toHaveBeenCalledWith(
      'RotaAnalyzeOrchestratorV1',
      input,
      { instanceId, version: '1.0.0' },
    );
    expect(clientMock.waitForOrchestrationCompletion).toHaveBeenCalledWith(instanceId, false, 120);
  });

  it('waits for an already active analysis without starting another', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.RUNNING,
    });
    clientMock.waitForOrchestrationCompletion.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.COMPLETED,
    });

    await new DurableRotaAnalyzeClient().execute(instanceId, input);

    expect(clientMock.scheduleNewOrchestration).not.toHaveBeenCalled();
    expect(clientMock.waitForOrchestrationCompletion).toHaveBeenCalledOnce();
  });

  it('reuses an already completed analysis without waiting', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.COMPLETED,
    });

    await new DurableRotaAnalyzeClient().execute(instanceId, input);

    expect(clientMock.scheduleNewOrchestration).not.toHaveBeenCalled();
    expect(clientMock.waitForOrchestrationCompletion).not.toHaveBeenCalled();
  });

  it('rejects terminal failure and unsuccessful wait completion', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValueOnce({
      runtimeStatus: OrchestrationStatus.FAILED,
    });
    await expect(new DurableRotaAnalyzeClient().execute(instanceId, input)).rejects.toThrow(
      /terminal/,
    );

    clientMock.getOrchestrationState.mockResolvedValueOnce({
      runtimeStatus: OrchestrationStatus.RUNNING,
    });
    clientMock.waitForOrchestrationCompletion.mockResolvedValueOnce({
      runtimeStatus: OrchestrationStatus.FAILED,
    });
    await expect(new DurableRotaAnalyzeClient().execute(instanceId, input)).rejects.toThrow(
      /did not complete/,
    );
  });

  it('fails closed without scheduler configuration', async () => {
    vi.stubEnv('DURABLE_TASK_SCHEDULER_CONNECTION_STRING', '');

    await expect(new DurableRotaAnalyzeClient().execute(instanceId, input)).rejects.toThrow(
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
