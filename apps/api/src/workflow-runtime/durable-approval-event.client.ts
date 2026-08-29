import { APPROVAL_DURABLE_EVENTS } from '@careos/contracts';
import { OrchestrationStatus, type TaskHubGrpcClient } from '@microsoft/durabletask-js';
import { createAzureManagedClient } from '@microsoft/durabletask-js-azuremanaged';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';

export interface ApprovalDurableEventClient {
  raiseDecision(instanceId: string, commandId: string): Promise<void>;
}

@Injectable()
export class DurableApprovalEventClient implements ApprovalDurableEventClient, OnModuleDestroy {
  private client: TaskHubGrpcClient | undefined;

  async raiseDecision(instanceId: string, commandId: string): Promise<void> {
    const client = this.getClient();
    const state = await client.getOrchestrationState(instanceId, false);
    if (state === undefined) {
      throw new NotFoundException(`Durable approval workflow ${instanceId} was not found.`);
    }
    if (
      ![
        OrchestrationStatus.PENDING,
        OrchestrationStatus.RUNNING,
        OrchestrationStatus.SUSPENDED,
        OrchestrationStatus.CONTINUED_AS_NEW,
      ].includes(state.runtimeStatus)
    ) {
      throw new ConflictException(`Durable approval workflow ${instanceId} is already terminal.`);
    }
    await client.raiseOrchestrationEvent(instanceId, APPROVAL_DURABLE_EVENTS.decide, {
      commandId,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.stop();
  }

  private getClient(): TaskHubGrpcClient {
    if (this.client !== undefined) return this.client;
    const connectionString = process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING?.trim();
    if (connectionString === undefined || connectionString === '') {
      throw new ServiceUnavailableException(
        'Durable Task Scheduler is not configured for approval routing.',
      );
    }
    this.client = createAzureManagedClient(connectionString);
    return this.client;
  }
}
