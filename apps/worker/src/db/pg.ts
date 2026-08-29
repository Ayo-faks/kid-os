// Minimal pg-backed persistence helper for worker activities.
//
// We deliberately keep this independent of the api's Prisma client to avoid
// cross-package generated-client gymnastics. The worker only needs raw SQL
// (INSERTs into core.incidents / incident_versions / timeline_entries plus
// audit.events) and the same per-transaction GUC dance that PrismaService
// performs on the api side.

import type { IncidentActor } from '@careos/contracts';
import { Pool, type PoolClient } from 'pg';

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set; worker activities cannot persist.');
    }
    pool = new Pool({ connectionString, max: 4 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export interface TenantSessionContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly actor: IncidentActor;
}

// Run `fn` inside a transaction with the seven `app.current_*` GUCs set so
// RLS allows the write and the audit triggers attribute it correctly.
export async function withTenantContext<T>(
  context: TenantSessionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT
         set_config('app.current_tenant_id',       $1, true),
         set_config('app.current_home_id',         $2, true),
         set_config('app.current_actor_kind',      $3, true),
         set_config('app.current_actor_user_id',   $4, true),
         set_config('app.current_correlation_id',  $5, true),
         set_config('app.current_agent_run_id',    $6, true),
         set_config('app.current_prompt_hash',     $7, true)`,
      [
        context.tenantId,
        context.homeId,
        context.actor.kind,
        context.actor.userId ?? '',
        context.actor.correlationId,
        context.actor.agentRunId ?? '',
        context.actor.promptHash ?? '',
      ],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface SystemSessionContext {
  readonly correlationId: string;
}

// Cross-tenant read context for scheduled sweeps. Sets actor_kind='system'
// with blank tenant/home so the `shifts_system_read` policy applies. Writes
// are still blocked because no system carve-out exists for WITH CHECK; a
// sweep must hand off per-row work to a tenant-scoped `withTenantContext`
// call before mutating anything.
export async function withSystemContext<T>(
  context: SystemSessionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT
         set_config('app.current_tenant_id',       '', true),
         set_config('app.current_home_id',         '', true),
         set_config('app.current_actor_kind',      'system', true),
         set_config('app.current_actor_user_id',   '', true),
         set_config('app.current_correlation_id',  $1, true),
         set_config('app.current_agent_run_id',    '', true),
         set_config('app.current_prompt_hash',     '', true)`,
      [context.correlationId],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
