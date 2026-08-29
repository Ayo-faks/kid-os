import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, Pool, type PoolClient, type QueryResultRow } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAllPrismaMigrations } from './prisma-migration-test-harness.js';
import { resolveCareosTestPostgresImage } from './test-postgres-image.js';

const runIntegration = process.env.CAREOS_RUN_PHASE4_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;
const migrationsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const homeA = '22222222-2222-4222-8222-222222222222';
const homeB = '33333333-3333-4333-8333-333333333333';
const homeC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userA = '44444444-4444-4444-8444-444444444444';
const userB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface NamedRow extends QueryResultRow {
  readonly name: string;
}

interface CountRow extends QueryResultRow {
  readonly count: number;
}

interface RetentionRunRow extends QueryResultRow {
  readonly affected_count: number;
  readonly id: string;
  readonly scanned_count: number;
}

describeIntegration('Phase 4 RLS isolation matrix', () => {
  let container: StartedTestContainer;
  let admin: Client;
  let appPool: Pool;

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
    await seedMatrix(admin);

    // Deliberately small: concurrent alternating contexts must reuse pooled
    // connections without carrying GUC state across transaction boundaries.
    appPool = new Pool({
      connectionString: postgresUrl('careos_app', 'change-me', container),
      max: 2,
    });
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await admin?.end();
    await container?.stop();
  });

  it.each([
    [
      'documents',
      'SELECT original_filename AS name FROM core.documents ORDER BY name',
      'a.pdf',
      'b.pdf',
    ],
    [
      'export bundles',
      'SELECT workflow_id AS name FROM core.export_bundles ORDER BY name',
      'bundle-a',
      'bundle-b',
    ],
    [
      'Mattermost mappings',
      'SELECT channel_name AS name FROM core.channel_mappings ORDER BY name',
      'Ash alerts',
      'Birch alerts',
    ],
    [
      'automation audit events',
      "SELECT metadata->>'name' AS name FROM audit.events WHERE action = 'test.automation' ORDER BY name",
      'automation-a',
      'automation-b',
    ],
  ])('isolates %s between homes', async (_label, sql, expectedA, expectedB) => {
    const rowsA = await queryAs<NamedRow>(appPool, tenantA, homeA, userA, sql);
    const rowsB = await queryAs<NamedRow>(appPool, tenantA, homeB, userA, sql);

    expect(rowsA.map((row) => row.name)).toEqual([expectedA]);
    expect(rowsB.map((row) => row.name)).toEqual([expectedB]);
  });

  it('isolates tenant-wide retention policies between tenants', async () => {
    const rowsA = await queryAs<NamedRow>(
      appPool,
      tenantA,
      homeA,
      userA,
      'SELECT record_type::text AS name FROM core.retention_policies ORDER BY name',
    );
    const rowsB = await queryAs<NamedRow>(
      appPool,
      tenantB,
      homeC,
      userB,
      'SELECT record_type::text AS name FROM core.retention_policies ORDER BY name',
    );

    expect(rowsA.map((row) => row.name)).toEqual(['incident']);
    expect(rowsB.map((row) => row.name)).toEqual(['attachment']);
  });

  it('records retention runs idempotently through the runtime execution key', async () => {
    const executionKeyColumns = await admin.query<CountRow>(`
      SELECT count(*)::int AS count
        FROM information_schema.columns
       WHERE table_schema = 'core'
         AND table_name = 'retention_runs'
         AND column_name = 'execution_key'
    `);
    expect(executionKeyColumns.rows[0]?.count).toBe(1);

    const sql = `INSERT INTO core.retention_runs
       (tenant_id, policy_id, workflow_id, execution_key, record_type, action,
        scanned_count, affected_count, started_at, completed_at)
     VALUES (
       '${tenantA}'::uuid,
       '30000000-0000-4000-8000-000000000001'::uuid,
       'retention-sweep-runtime',
       '30000000-0000-4000-8000-000000000001:retention-sweep-runtime',
       'incident'::core."RetentionRecordType",
       'soft_delete'::core."RetentionAction",
       9, 7, NOW(), NOW()
     )
     ON CONFLICT (execution_key) WHERE execution_key IS NOT NULL
     DO UPDATE SET workflow_id = EXCLUDED.workflow_id
     RETURNING id::text AS id, scanned_count, affected_count`;

    const first = await queryAs<RetentionRunRow>(appPool, tenantA, homeA, userA, sql);
    const retry = await queryAs<RetentionRunRow>(appPool, tenantA, homeA, userA, sql);

    expect(first).toHaveLength(1);
    expect(retry).toEqual(first);
    expect(first[0]).toMatchObject({ affected_count: 7, scanned_count: 9 });
  });

  it('does not leak under concurrent alternating contexts on a two-connection pool', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) => {
        const useHomeA = index % 2 === 0;
        return queryAs<CountRow>(
          appPool,
          tenantA,
          useHomeA ? homeA : homeB,
          userA,
          `SELECT COUNT(*)::int AS count
             FROM core.documents d
             JOIN core.channel_mappings c
               ON c.tenant_id = d.tenant_id AND c.home_id = d.home_id`,
        );
      }),
    );

    expect(results.every((rows) => rows[0]?.count === 1)).toBe(true);
  });
});

async function queryAs<T extends QueryResultRow>(
  pool: Pool,
  tenantId: string,
  homeId: string,
  actorUserId: string,
  sql: string,
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setContext(client, tenantId, homeId, actorUserId);
    const result = await client.query<T>(sql);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function setContext(
  client: PoolClient,
  tenantId: string,
  homeId: string,
  actorUserId: string,
): Promise<void> {
  await client.query(
    `SELECT
       set_config('app.current_tenant_id', $1, true),
       set_config('app.current_home_id', $2, true),
       set_config('app.current_actor_kind', 'user', true),
       set_config('app.current_actor_user_id', $3, true),
       set_config('app.current_correlation_id', 'phase4-rls-test', true),
       set_config('app.current_agent_run_id', '', true),
       set_config('app.current_prompt_hash', '', true)`,
    [tenantId, homeId, actorUserId],
  );
}

async function seedMatrix(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO core.tenants (id, name, updated_at) VALUES
      ('${tenantA}', 'Tenant A', now()),
      ('${tenantB}', 'Tenant B', now());

    INSERT INTO core.homes (id, tenant_id, name, updated_at) VALUES
      ('${homeA}', '${tenantA}', 'Ash', now()),
      ('${homeB}', '${tenantA}', 'Birch', now()),
      ('${homeC}', '${tenantB}', 'Cedar', now());

    INSERT INTO core.users
      (id, tenant_id, keycloak_sub, email, display_name, home_ids, roles, updated_at)
    VALUES
      ('${userA}', '${tenantA}', 'sub-a', 'a@example.test', 'User A',
       ARRAY['${homeA}', '${homeB}']::uuid[], ARRAY['manager'], now()),
      ('${userB}', '${tenantB}', 'sub-b', 'b@example.test', 'User B',
       ARRAY['${homeC}']::uuid[], ARRAY['manager'], now());

    INSERT INTO core.residents
      (id, tenant_id, home_id, first_name, last_name, date_of_birth, arrived_at, updated_at)
    VALUES
      ('55555555-5555-4555-8555-555555555555', '${tenantA}', '${homeA}', 'A', 'Resident', DATE '2010-01-01', now(), now()),
      ('66666666-6666-4666-8666-666666666666', '${tenantA}', '${homeB}', 'B', 'Resident', DATE '2011-01-01', now(), now()),
      ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '${tenantB}', '${homeC}', 'C', 'Resident', DATE '2012-01-01', now(), now());

    INSERT INTO core.form_templates
      (id, tenant_id, template_id, version, title, schema, ui_schema)
    VALUES
      ('77777777-7777-4777-8777-777777777777', '${tenantA}', 'incident.behavioural', 'v1', 'Behavioural', '{}'::jsonb, '{}'::jsonb),
      ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '${tenantB}', 'incident.safeguarding', 'v1', 'Safeguarding', '{}'::jsonb, '{}'::jsonb);

    INSERT INTO core.incidents
      (id, tenant_id, home_id, resident_id, form_template_id, author_user_id, updated_at)
    VALUES
      ('88888888-8888-4888-8888-888888888888', '${tenantA}', '${homeA}', '55555555-5555-4555-8555-555555555555', '77777777-7777-4777-8777-777777777777', '${userA}', now()),
      ('99999999-9999-4999-8999-999999999999', '${tenantA}', '${homeB}', '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777', '${userA}', now()),
      ('ffffffff-ffff-4fff-8fff-ffffffffffff', '${tenantB}', '${homeC}', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '${userB}', now());

    INSERT INTO core.documents
      (id, tenant_id, home_id, uploader_user_id, workflow_id, object_key,
       original_filename, mime_type, size_bytes, updated_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '${tenantA}', '${homeA}', '${userA}', 'doc-a', 'a/key', 'a.pdf', 'application/pdf', 10, now()),
      ('10000000-0000-4000-8000-000000000002', '${tenantA}', '${homeB}', '${userA}', 'doc-b', 'b/key', 'b.pdf', 'application/pdf', 20, now()),
      ('10000000-0000-4000-8000-000000000003', '${tenantB}', '${homeC}', '${userB}', 'doc-c', 'c/key', 'c.pdf', 'application/pdf', 30, now());

    INSERT INTO core.export_bundles
      (id, tenant_id, home_id, incident_id, requested_by_user_id, workflow_id, updated_at)
    VALUES
      ('20000000-0000-4000-8000-000000000001', '${tenantA}', '${homeA}', '88888888-8888-4888-8888-888888888888', '${userA}', 'bundle-a', now()),
      ('20000000-0000-4000-8000-000000000002', '${tenantA}', '${homeB}', '99999999-9999-4999-8999-999999999999', '${userA}', 'bundle-b', now()),
      ('20000000-0000-4000-8000-000000000003', '${tenantB}', '${homeC}', 'ffffffff-ffff-4fff-8fff-ffffffffffff', '${userB}', 'bundle-c', now());

    INSERT INTO core.retention_policies
      (id, tenant_id, record_type, retention_days, action, updated_at)
    VALUES
      ('30000000-0000-4000-8000-000000000001', '${tenantA}', 'incident', 365, 'soft_delete', now()),
      ('30000000-0000-4000-8000-000000000002', '${tenantB}', 'attachment', 30, 'object_delete', now());

    INSERT INTO core.channel_mappings
      (id, tenant_id, home_id, kind, channel_id, channel_name, updated_at)
    VALUES
      ('40000000-0000-4000-8000-000000000001', '${tenantA}', '${homeA}', 'home', 'channel-a', 'Ash alerts', now()),
      ('40000000-0000-4000-8000-000000000002', '${tenantA}', '${homeB}', 'home', 'channel-b', 'Birch alerts', now()),
      ('40000000-0000-4000-8000-000000000003', '${tenantB}', '${homeC}', 'home', 'channel-c', 'Cedar alerts', now());

    INSERT INTO audit.events
      (tenant_id, home_id, actor_kind, correlation_id, action, subject_type, subject_id, metadata)
    VALUES
      ('${tenantA}', '${homeA}', 'system', 'auto-a', 'test.automation', 'home', '${homeA}', '{"name":"automation-a"}'::jsonb),
      ('${tenantA}', '${homeB}', 'system', 'auto-b', 'test.automation', 'home', '${homeB}', '{"name":"automation-b"}'::jsonb),
      ('${tenantB}', '${homeC}', 'system', 'auto-c', 'test.automation', 'home', '${homeC}', '{"name":"automation-c"}'::jsonb);
  `);
}

function postgresUrl(user: string, password: string, container: StartedTestContainer): string {
  const host = container.getHost() === 'localhost' ? '127.0.0.1' : container.getHost();
  return `postgresql://${user}:${password}@${host}:${container.getMappedPort(5432)}/careos?schema=public`;
}
