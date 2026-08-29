import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, Pool, type PoolClient, type QueryResultRow } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAllPrismaMigrations } from './prisma-migration-test-harness.js';
import { resolveCareosTestPostgresImage } from './test-postgres-image.js';

const runIntegration = process.env.CAREOS_RUN_DURABLE_TENANT_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;
const migrationsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const homeA = '22222222-2222-4222-8222-222222222222';
const homeB = '33333333-3333-4333-8333-333333333333';
const homeC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userA = '44444444-4444-4444-8444-444444444444';
const userB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface Scope {
  readonly tenantId: string;
  readonly homeId: string;
  readonly userId: string;
  readonly subjectId: string;
  readonly instanceId: string;
  readonly privatePayload: string;
}

interface OwnerRow extends QueryResultRow {
  readonly id: string;
  readonly instance_id: string;
}

interface CommandRow extends QueryResultRow {
  readonly id: string;
}

interface VisibleRows extends QueryResultRow {
  readonly instance_id: string;
  readonly command_count: number;
}

interface MetadataRow extends QueryResultRow {
  readonly metadata: unknown;
}

const scopes: readonly Scope[] = [
  {
    homeId: homeA,
    instanceId: 'tenant-a-home-a-workflow',
    privatePayload: 'private-a-home-a',
    subjectId: '55555555-5555-4555-8555-555555555555',
    tenantId: tenantA,
    userId: userA,
  },
  {
    homeId: homeB,
    instanceId: 'tenant-a-home-b-workflow',
    privatePayload: 'private-a-home-b',
    subjectId: '66666666-6666-4666-8666-666666666666',
    tenantId: tenantA,
    userId: userA,
  },
  {
    homeId: homeC,
    instanceId: 'tenant-b-home-c-workflow',
    privatePayload: 'private-b-home-c',
    subjectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    tenantId: tenantB,
    userId: userB,
  },
];

describeIntegration('Durable workflow tenant isolation and idempotency', () => {
  let container: StartedTestContainer;
  let admin: Client;
  let appPool: Pool;
  const owners = new Map<string, OwnerRow>();
  const commands = new Map<string, CommandRow>();

  beforeAll(async () => {
    container = await new GenericContainer(resolveCareosTestPostgresImage())
      .withEnvironment({
        POSTGRES_DB: 'careos',
        POSTGRES_PASSWORD: 'change-me',
        POSTGRES_USER: 'careos',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    admin = new Client({ connectionString: postgresUrl('careos', 'change-me', container) });
    await admin.connect();
    await admin.query(
      "CREATE ROLE careos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD 'change-me'",
    );
    await applyAllPrismaMigrations(admin, migrationsRoot);
    await seedIdentities(admin);

    appPool = new Pool({
      connectionString: postgresUrl('careos_app', 'change-me', container),
      max: 2,
    });
    for (const scope of scopes) {
      const result = await withScope(appPool, scope, async (client) => {
        const owner = await registerOwner(client, scope);
        const command = await registerCommand(client, owner.id, scope);
        return { command, owner };
      });
      owners.set(scope.instanceId, result.owner);
      commands.set(scope.instanceId, result.command);
    }
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await admin?.end();
    await container?.stop();
  });

  it('deduplicates concurrent owner registration and command persistence', async () => {
    const scope = scopes[0];
    if (scope === undefined) throw new Error('Missing tenant test scope.');
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        withScope(appPool, scope, async (client) => {
          const owner = await registerOwner(client, scope);
          const command = await registerCommand(client, owner.id, scope);
          return { commandId: command.id, ownerId: owner.id };
        }),
      ),
    );

    expect(new Set(results.map((result) => result.ownerId))).toEqual(
      new Set([owners.get(scope.instanceId)?.id]),
    );
    expect(new Set(results.map((result) => result.commandId))).toEqual(
      new Set([commands.get(scope.instanceId)?.id]),
    );
    await expect(visibleRows(appPool, scope)).resolves.toEqual([
      { command_count: 1, instance_id: scope.instanceId },
    ]);
  });

  it('does not leak owners or commands under alternating pooled tenant contexts', async () => {
    const results = await Promise.all(
      Array.from({ length: 60 }, async (_, index) => {
        const scope = scopes[index % scopes.length];
        if (scope === undefined) throw new Error('Missing tenant test scope.');
        return { rows: await visibleRows(appPool, scope), scope };
      }),
    );

    for (const result of results) {
      expect(result.rows).toEqual([{ command_count: 1, instance_id: result.scope.instanceId }]);
    }
  });

  it('blocks writes whose row tenant or home differs from the active GUC context', async () => {
    const activeScope = scopes[0];
    const foreignScope = scopes[2];
    if (activeScope === undefined || foreignScope === undefined) {
      throw new Error('Missing tenant test scope.');
    }
    await expect(
      withScope(appPool, activeScope, (client) =>
        registerOwner(client, {
          ...foreignScope,
          instanceId: 'foreign-context-write',
          subjectId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('keeps private command payloads out of append-only workflow audit metadata', async () => {
    for (const scope of scopes) {
      const metadata = await withScope(appPool, scope, async (client) => {
        const result = await client.query<MetadataRow>(
          `SELECT metadata
             FROM audit.events
            WHERE subject_type IN ('workflow_instance', 'workflow_command')
            ORDER BY occurred_at, id`,
        );
        return result.rows;
      });
      const serialized = JSON.stringify(metadata);
      expect(serialized).not.toContain(scope.privatePayload);
      for (const otherScope of scopes.filter((candidate) => candidate !== scope)) {
        expect(serialized).not.toContain(otherScope.instanceId);
        expect(serialized).not.toContain(otherScope.privatePayload);
      }
    }
  });
});

async function withScope<T>(
  pool: Pool,
  scope: Scope,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT
         set_config('app.current_tenant_id', $1, true),
         set_config('app.current_home_id', $2, true),
         set_config('app.current_actor_kind', 'user', true),
         set_config('app.current_actor_user_id', $3, true),
         set_config('app.current_correlation_id', 'durable-tenant-test', true),
         set_config('app.current_agent_run_id', '', true),
         set_config('app.current_prompt_hash', '', true)`,
      [scope.tenantId, scope.homeId, scope.userId],
    );
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function registerOwner(client: PoolClient, scope: Scope): Promise<OwnerRow> {
  const result = await client.query<OwnerRow>(
    `INSERT INTO core.workflow_instances (
       id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
       runtime, instance_id, orchestration_name, orchestration_version,
       status, correlation_id, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), $1::uuid, $2::uuid, 'tenant-test', 'test-subject', $3::uuid,
       'durable'::"core"."WorkflowRuntimeKind", $4, 'TenantIsolationProbe', '1.0.0',
       'running', 'durable-tenant-test', now(), now()
     )
     ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
     DO UPDATE SET instance_id = core.workflow_instances.instance_id
     RETURNING id::text, instance_id`,
    [scope.tenantId, scope.homeId, scope.subjectId, scope.instanceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Workflow owner was not registered.');
  return row;
}

async function registerCommand(
  client: PoolClient,
  workflowInstanceId: string,
  scope: Scope,
): Promise<CommandRow> {
  const payload = JSON.stringify({ privateValue: scope.privatePayload });
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const result = await client.query<CommandRow>(
    `INSERT INTO core.workflow_commands (
       id, tenant_id, home_id, workflow_instance_id, command_type,
       payload, payload_hash, status, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'tenant-test.apply',
       $5::jsonb, $6, 'pending'::"core"."WorkflowCommandStatus", now(), now()
     )
     ON CONFLICT (workflow_instance_id, command_type, payload_hash)
     DO UPDATE SET payload_hash = EXCLUDED.payload_hash
     RETURNING id::text`,
    [randomUUID(), scope.tenantId, scope.homeId, workflowInstanceId, payload, payloadHash],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Workflow command was not registered.');
  return row;
}

function visibleRows(pool: Pool, scope: Scope): Promise<VisibleRows[]> {
  return withScope(appPoolFor(pool), scope, async (client) => {
    const result = await client.query<VisibleRows>(
      `SELECT w.instance_id, COUNT(c.id)::int AS command_count
         FROM core.workflow_instances w
         LEFT JOIN core.workflow_commands c ON c.workflow_instance_id = w.id
        GROUP BY w.id, w.instance_id
        ORDER BY w.instance_id`,
    );
    return result.rows;
  });
}

function appPoolFor(pool: Pool): Pool {
  return pool;
}

async function seedIdentities(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO core.tenants (id, name, updated_at) VALUES
       ($1::uuid, 'Tenant A', now()),
       ($2::uuid, 'Tenant B', now())`,
    [tenantA, tenantB],
  );
  await client.query(
    `INSERT INTO core.homes (id, tenant_id, name, updated_at) VALUES
       ($1::uuid, $2::uuid, 'Ash', now()),
       ($3::uuid, $2::uuid, 'Birch', now()),
       ($4::uuid, $5::uuid, 'Cedar', now())`,
    [homeA, tenantA, homeB, homeC, tenantB],
  );
  await client.query(
    `INSERT INTO core.users
       (id, tenant_id, keycloak_sub, email, display_name, home_ids, roles, updated_at)
     VALUES
       ($1::uuid, $2::uuid, 'durable-user-a', 'a@example.test', 'User A',
        ARRAY[$3::uuid, $4::uuid], ARRAY['manager'], now()),
       ($5::uuid, $6::uuid, 'durable-user-b', 'b@example.test', 'User B',
        ARRAY[$7::uuid], ARRAY['manager'], now())`,
    [userA, tenantA, homeA, homeB, userB, tenantB, homeC],
  );
}

function postgresUrl(user: string, password: string, container: StartedTestContainer): string {
  const host = container.getHost() === 'localhost' ? '127.0.0.1' : container.getHost();
  return `postgresql://${user}:${password}@${host}:${container.getMappedPort(5432)}/careos?schema=public`;
}
