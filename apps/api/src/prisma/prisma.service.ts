import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type ActorKind = 'user' | 'agent' | 'system';

export interface ActorContext {
  readonly kind: ActorKind;
  readonly userId?: string | null;
  readonly correlationId?: string | null;
  readonly agentRunId?: string | null;
  readonly promptHash?: string | null;
}

export interface TenantDatabaseContext {
  readonly actor: ActorContext;
  readonly homeId: string;
  readonly tenantId: string;
}

export interface SystemDatabaseContext {
  readonly correlationId: string;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async withTenantContext<T>(
    context: TenantDatabaseContext,
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const kind = context.actor.kind;
    const userId = context.actor.userId ?? '';
    const correlationId = context.actor.correlationId ?? '';
    const agentRunId = context.actor.agentRunId ?? '';
    const promptHash = context.actor.promptHash ?? '';

    return this.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT
          set_config('app.current_tenant_id', ${context.tenantId}, true),
          set_config('app.current_home_id', ${context.homeId}, true),
          set_config('app.current_actor_kind', ${kind}, true),
          set_config('app.current_actor_user_id', ${userId}, true),
          set_config('app.current_correlation_id', ${correlationId}, true),
          set_config('app.current_agent_run_id', ${agentRunId}, true),
          set_config('app.current_prompt_hash', ${promptHash}, true)
      `;

      return callback(transaction);
    });
  }

  async withSystemContext<T>(
    context: SystemDatabaseContext,
    callback: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (transaction) => {
      await transaction.$executeRaw`
        SELECT
          set_config('app.current_tenant_id', '', true),
          set_config('app.current_home_id', '', true),
          set_config('app.current_actor_kind', 'system', true),
          set_config('app.current_actor_user_id', '', true),
          set_config('app.current_correlation_id', ${context.correlationId}, true),
          set_config('app.current_agent_run_id', '', true),
          set_config('app.current_prompt_hash', '', true)
      `;

      return callback(transaction);
    });
  }
}
