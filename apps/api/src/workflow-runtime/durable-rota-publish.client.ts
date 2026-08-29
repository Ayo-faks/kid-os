import {
  ROTA_PUBLISH_DURABLE_VERSION,
  ROTA_PUBLISH_DURABLE_WORKFLOW_TYPE,
  type RotaPublishDurableWorkflowInput,
} from '@careos/contracts';
import { OrchestrationStatus, type TaskHubGrpcClient } from '@microsoft/durabletask-js';
import { createAzureManagedClient } from '@microsoft/durabletask-js-azuremanaged';
import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';

export interface RotaPublishDurableClient {
  start(instanceId: string, input: RotaPublishDurableWorkflowInput): Promise<void>;
}

@Injectable()
export class DurableRotaPublishClient implements RotaPublishDurableClient, OnModuleDestroy {
  private client: TaskHubGrpcClient | undefined;

  async start(instanceId: string, input: RotaPublishDurableWorkflowInput): Promise<void> {
    const client = this.getClient();
    const existing = await client.getOrchestrationState(instanceId, false);
    if (existing !== undefined) {
      if (isNonTerminal(existing.runtimeStatus)) return;
      throw new ConflictException(
        `Durable Rota Publish workflow ${instanceId} is already terminal.`,
      );
    }
    try {
      await client.scheduleNewOrchestration(ROTA_PUBLISH_DURABLE_WORKFLOW_TYPE, input, {
        instanceId,
        version: ROTA_PUBLISH_DURABLE_VERSION,
      });
    } catch (startError) {
      const raced = await client.getOrchestrationState(instanceId, false).catch(() => undefined);
      if (raced !== undefined && isNonTerminal(raced.runtimeStatus)) return;
      throw startError;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.stop();
  }

  private getClient(): TaskHubGrpcClient {
    if (this.client !== undefined) return this.client;
    const connectionString = process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING?.trim();
    if (connectionString === undefined || connectionString === '') {
      throw new ServiceUnavailableException(
        'Durable Task Scheduler is not configured for Rota Publish workflows.',
      );
    }
    this.client = createAzureManagedClient(connectionString);
    return this.client;
  }
}

function isNonTerminal(status: OrchestrationStatus): boolean {
  return [
    OrchestrationStatus.PENDING,
    OrchestrationStatus.RUNNING,
    OrchestrationStatus.SUSPENDED,
    OrchestrationStatus.CONTINUED_AS_NEW,
  ].includes(status);
}
