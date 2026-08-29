import {
  HistoryEventType,
  OrchestrationStatus,
  type HistoryEvent,
  type OrchestrationQuery,
} from '@microsoft/durabletask-js';

const NON_TERMINAL_STATUSES = [
  OrchestrationStatus.PENDING,
  OrchestrationStatus.RUNNING,
  OrchestrationStatus.SUSPENDED,
  OrchestrationStatus.CONTINUED_AS_NEW,
] as const;

export interface DurableVersionInventoryClient {
  getAllInstances(
    filter: OrchestrationQuery,
  ): AsyncIterable<{ readonly instanceId: string; readonly tags?: Record<string, string> }>;
  getOrchestrationHistory(instanceId: string): Promise<HistoryEvent[]>;
}

export interface DurableVersionRetirementReport {
  readonly activeInstanceIds: readonly string[];
  readonly canRetire: boolean;
  readonly version: string;
}

export async function inspectDurableVersionRetirement(
  client: DurableVersionInventoryClient,
  version: string,
): Promise<DurableVersionRetirementReport> {
  assertOperationalVersion(version);
  const activeInstanceIds: string[] = [];
  const instances = client.getAllInstances({
    fetchInputsAndOutputs: false,
    statuses: [...NON_TERMINAL_STATUSES],
  });

  for await (const instance of instances) {
    const history = await client.getOrchestrationHistory(instance.instanceId);
    const started = history.find((event) => event.type === HistoryEventType.ExecutionStarted);
    if (started?.type === HistoryEventType.ExecutionStarted && started.version === version) {
      activeInstanceIds.push(instance.instanceId);
    }
  }

  activeInstanceIds.sort();
  return {
    activeInstanceIds,
    canRetire: activeInstanceIds.length === 0,
    version,
  };
}

function assertOperationalVersion(version: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(version)) {
    throw new Error('Durable orchestration version must be operational metadata.');
  }
}
