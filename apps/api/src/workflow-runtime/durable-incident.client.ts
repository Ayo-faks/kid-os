import {
  INCIDENT_DURABLE_EVENTS,
  INCIDENT_DURABLE_VERSION,
  INCIDENT_DURABLE_WORKFLOW_TYPE,
} from '@careos/contracts';
import { OrchestrationStatus, type TaskHubGrpcClient } from '@microsoft/durabletask-js';
import { createAzureManagedClient } from '@microsoft/durabletask-js-azuremanaged';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';

export interface DurableIncidentStartInput {
  readonly actor: {
    readonly correlationId: string;
    readonly kind: 'user';
    readonly userId: string;
  };
  readonly authorUserId: string;
  readonly formTemplate: {
    readonly templateId: string;
    readonly version: string;
  };
  readonly homeId: string;
  readonly incidentId: string;
  readonly initialCommandId: string;
  readonly residentId: string;
  readonly tenantId: string;
}

export interface IncidentDurableClient {
  raiseCommand(instanceId: string, commandId: string): Promise<void>;
  start(instanceId: string, input: DurableIncidentStartInput): Promise<void>;
}

@Injectable()
export class DurableIncidentClient implements IncidentDurableClient, OnModuleDestroy {
  private client: TaskHubGrpcClient | undefined;

  async start(instanceId: string, input: DurableIncidentStartInput): Promise<void> {
    const client = this.getClient();
    const existing = await client.getOrchestrationState(instanceId, false);
    if (existing !== undefined) {
      if (isNonTerminal(existing.runtimeStatus)) return;
      throw new ConflictException(`Durable incident workflow ${instanceId} is already terminal.`);
    }
    try {
      await client.scheduleNewOrchestration(INCIDENT_DURABLE_WORKFLOW_TYPE, input, {
        instanceId,
        version: INCIDENT_DURABLE_VERSION,
      });
    } catch (startError) {
      const raced = await client.getOrchestrationState(instanceId, false).catch(() => undefined);
      if (raced !== undefined && isNonTerminal(raced.runtimeStatus)) return;
      throw startError;
    }
  }

  async raiseCommand(instanceId: string, commandId: string): Promise<void> {
    const client = this.getClient();
    const state = await client.getOrchestrationState(instanceId, false);
    if (state === undefined) {
      throw new NotFoundException(`Durable incident workflow ${instanceId} was not found.`);
    }
    if (!isNonTerminal(state.runtimeStatus)) {
      throw new ConflictException(`Durable incident workflow ${instanceId} is already terminal.`);
    }
    await client.raiseOrchestrationEvent(instanceId, INCIDENT_DURABLE_EVENTS.command, {
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
        'Durable Task Scheduler is not configured for incident workflows.',
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
