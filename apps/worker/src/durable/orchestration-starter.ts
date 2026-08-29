import type { OrchestrationState, StartOrchestrationOptions } from '@microsoft/durabletask-js';

export interface DurableOrchestrationStarter {
  getOrchestrationState(
    instanceId: string,
    fetchPayloads?: boolean,
  ): Promise<OrchestrationState | undefined>;
  scheduleNewOrchestration(
    orchestrator: string,
    input: unknown,
    options: StartOrchestrationOptions,
  ): Promise<string>;
}

export async function scheduleDurableOrchestrationIdempotently(
  client: DurableOrchestrationStarter,
  orchestrator: string,
  input: unknown,
  options: StartOrchestrationOptions & { readonly instanceId: string },
): Promise<string> {
  try {
    return await client.scheduleNewOrchestration(orchestrator, input, options);
  } catch (startError) {
    try {
      const existing = await client.getOrchestrationState(options.instanceId, false);
      if (existing !== undefined) return options.instanceId;
    } catch {
      // Preserve the original start error; it identifies the failed operation.
    }
    throw startError;
  }
}
