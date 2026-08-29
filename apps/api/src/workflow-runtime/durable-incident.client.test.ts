import { OrchestrationStatus } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const clientMock = vi.hoisted(() => ({
  getOrchestrationState: vi.fn(),
  raiseOrchestrationEvent: vi.fn(),
  scheduleNewOrchestration: vi.fn(),
  stop: vi.fn(),
}));
const createClientMock = vi.hoisted(() => vi.fn(() => clientMock));

vi.mock('@microsoft/durabletask-js-azuremanaged', () => ({
  createAzureManagedClient: createClientMock,
}));

import {
  DurableIncidentClient,
  type DurableIncidentStartInput,
} from './durable-incident.client.js';

const incidentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const instanceId = `incident-${incidentId}`;
const commandId = '88888888-8888-4888-8888-888888888888';
const input: DurableIncidentStartInput = {
  actor: {
    correlationId: 'corr-incident',
    kind: 'user',
    userId: '44444444-4444-4444-8444-444444444444',
  },
  authorUserId: '44444444-4444-4444-8444-444444444444',
  formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId,
  initialCommandId: commandId,
  residentId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('DurableIncidentClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('starts a versioned ID-only incident orchestration', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue(undefined);
    clientMock.scheduleNewOrchestration.mockResolvedValue(instanceId);
    const client = new DurableIncidentClient();

    await client.start(instanceId, input);

    expect(clientMock.scheduleNewOrchestration).toHaveBeenCalledWith(
      'IncidentReportOrchestratorV1',
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
    const client = new DurableIncidentClient();

    await expect(client.start(instanceId, input)).resolves.toBeUndefined();
  });

  it('raises only the opaque command id for a running incident', async () => {
    configure();
    clientMock.getOrchestrationState.mockResolvedValue({
      runtimeStatus: OrchestrationStatus.RUNNING,
    });
    clientMock.raiseOrchestrationEvent.mockResolvedValue(undefined);
    const client = new DurableIncidentClient();

    await client.raiseCommand(instanceId, commandId);

    expect(clientMock.raiseOrchestrationEvent).toHaveBeenCalledWith(instanceId, 'incidentCommand', {
      commandId,
    });
  });

  it('rejects missing and terminal incidents', async () => {
    configure();
    const missing = new DurableIncidentClient();
    clientMock.getOrchestrationState.mockResolvedValueOnce(undefined);
    await expect(missing.raiseCommand(instanceId, commandId)).rejects.toThrow(/not found/);

    const terminal = new DurableIncidentClient();
    clientMock.getOrchestrationState.mockResolvedValueOnce({
      runtimeStatus: OrchestrationStatus.COMPLETED,
    });
    await expect(terminal.raiseCommand(instanceId, commandId)).rejects.toThrow(/terminal/);
  });

  it('fails closed without scheduler configuration', async () => {
    vi.stubEnv('DURABLE_TASK_SCHEDULER_CONNECTION_STRING', '');
    const client = new DurableIncidentClient();
    await expect(client.start(instanceId, input)).rejects.toThrow(/not configured/);
  });
});

function configure(): void {
  vi.stubEnv(
    'DURABLE_TASK_SCHEDULER_CONNECTION_STRING',
    'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
  );
}
