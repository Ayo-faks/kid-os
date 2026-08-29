import {
  ROTA_ANALYZE_DURABLE_VERSION,
  ROTA_ANALYZE_DURABLE_WORKFLOW_TYPE,
  type RotaAnalyzeDurableWorkflowInput,
} from '@careos/contracts';
import { OrchestrationStatus, type TaskHubGrpcClient } from '@microsoft/durabletask-js';
import { createAzureManagedClient } from '@microsoft/durabletask-js-azuremanaged';
import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';

const ROTA_ANALYSIS_TIMEOUT_SECONDS = 120;

export interface RotaAnalyzeDurableClient {
  execute(instanceId: string, input: RotaAnalyzeDurableWorkflowInput): Promise<void>;
}

@Injectable()
export class DurableRotaAnalyzeClient implements RotaAnalyzeDurableClient, OnModuleDestroy {
  private client: TaskHubGrpcClient | undefined;

  async execute(instanceId: string, input: RotaAnalyzeDurableWorkflowInput): Promise<void> {
    const client = this.getClient();
    const existing = await client.getOrchestrationState(instanceId, false);
    if (existing === undefined) {
      try {
        await client.scheduleNewOrchestration(ROTA_ANALYZE_DURABLE_WORKFLOW_TYPE, input, {
          instanceId,
          version: ROTA_ANALYZE_DURABLE_VERSION,
        });
      } catch (startError) {
        const raced = await client.getOrchestrationState(instanceId, false).catch(() => undefined);
        if (raced === undefined || !isNonTerminal(raced.runtimeStatus)) throw startError;
      }
    } else if (existing.runtimeStatus === OrchestrationStatus.COMPLETED) {
      return;
    } else if (!isNonTerminal(existing.runtimeStatus)) {
      throw new ConflictException(`Durable Rota Analyze workflow ${instanceId} is terminal.`);
    }

    const completed = await client.waitForOrchestrationCompletion(
      instanceId,
      false,
      ROTA_ANALYSIS_TIMEOUT_SECONDS,
    );
    if (completed?.runtimeStatus !== OrchestrationStatus.COMPLETED) {
      throw new ServiceUnavailableException('Durable Rota Analyze workflow did not complete.');
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
        'Durable Task Scheduler is not configured for Rota Analyze workflows.',
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
