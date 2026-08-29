import {
  HistoryEventType,
  OrchestrationStatus,
  type HistoryEvent,
  type OrchestrationQuery,
} from '@microsoft/durabletask-js';
import { describe, expect, it, vi } from 'vitest';

import {
  type DurableVersionInventoryClient,
  inspectDurableVersionRetirement,
} from './version-retirement.js';

describe('inspectDurableVersionRetirement', () => {
  it('blocks retirement while matching non-terminal histories remain', async () => {
    const getAllInstances = vi.fn((_filter: OrchestrationQuery) =>
      instances('instance-v2', 'instance-v1-b', 'instance-v1-a'),
    );
    const getOrchestrationHistory = vi.fn((instanceId: string) =>
      Promise.resolve([executionStarted(instanceId.startsWith('instance-v1') ? '1.0.0' : '2.0.0')]),
    );
    const client: DurableVersionInventoryClient = {
      getAllInstances,
      getOrchestrationHistory,
    };

    await expect(inspectDurableVersionRetirement(client, '1.0.0')).resolves.toEqual({
      activeInstanceIds: ['instance-v1-a', 'instance-v1-b'],
      canRetire: false,
      version: '1.0.0',
    });
    expect(getAllInstances).toHaveBeenCalledWith({
      fetchInputsAndOutputs: false,
      statuses: [
        OrchestrationStatus.PENDING,
        OrchestrationStatus.RUNNING,
        OrchestrationStatus.SUSPENDED,
        OrchestrationStatus.CONTINUED_AS_NEW,
      ],
    });
  });

  it('allows retirement only when no matching history remains', async () => {
    const client: DurableVersionInventoryClient = {
      getAllInstances: () => instances('instance-v2'),
      getOrchestrationHistory: () => Promise.resolve([executionStarted('2.0.0')]),
    };

    await expect(inspectDurableVersionRetirement(client, '1.0.0')).resolves.toEqual({
      activeInstanceIds: [],
      canRetire: true,
      version: '1.0.0',
    });
  });

  it('rejects free-form version metadata', async () => {
    const client: DurableVersionInventoryClient = {
      getAllInstances: () => instances(),
      getOrchestrationHistory: () => Promise.resolve([]),
    };

    await expect(
      inspectDurableVersionRetirement(client, 'private resident version notes'),
    ).rejects.toThrow(/operational metadata/);
  });
});

// eslint-disable-next-line @typescript-eslint/require-await -- Mirrors AsyncPageable iteration.
async function* instances(...instanceIds: readonly string[]) {
  for (const instanceId of instanceIds) yield { instanceId };
}

function executionStarted(version: string): HistoryEvent {
  return {
    eventId: 0,
    name: 'VersionRoutingProbeOrchestrator',
    timestamp: new Date('2026-07-18T00:00:00.000Z'),
    type: HistoryEventType.ExecutionStarted,
    version,
  };
}
