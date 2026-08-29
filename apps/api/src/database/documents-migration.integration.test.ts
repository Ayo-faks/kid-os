import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { type StartedTestContainer, GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAllPrismaMigrations } from './prisma-migration-test-harness.js';
import { resolveCareosTestPostgresImage } from './test-postgres-image.js';

const runIntegration = process.env.CAREOS_RUN_PHASE3_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;
const migrationsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeAId = '22222222-2222-4222-8222-222222222222';
const homeBId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const documentId = '55555555-5555-4555-8555-555555555555';

describeIntegration('documents migration access contracts', () => {
  let container: StartedTestContainer;
  let admin: Client;
  let app: Client;

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
    await admin.query(`
      INSERT INTO core.tenants (id, name, updated_at)
      VALUES ('${tenantId}', 'CareOS Test', now());
      INSERT INTO core.homes (id, tenant_id, name, updated_at)
      VALUES
        ('${homeAId}', '${tenantId}', 'Ash House', now()),
        ('${homeBId}', '${tenantId}', 'Birch House', now());
      INSERT INTO core.users
        (id, tenant_id, keycloak_sub, email, display_name, home_ids, roles, updated_at)
      VALUES
        ('${userId}', '${tenantId}', 'document-user', 'document@example.test',
         'Document User', ARRAY['${homeAId}']::uuid[], ARRAY['support_worker'], now());
    `);

    app = new Client({ connectionString: postgresUrl('careos_app', 'change-me', container) });
    await app.connect();
  }, 180_000);

  afterAll(async () => {
    await app?.end();
    await admin?.end();
    await container?.stop();
  });

  it('grants tenant-scoped document access and emits append-only audit evidence', async () => {
    await app.query('BEGIN');
    await setContext(app, homeAId);
    await app.query(
      `INSERT INTO core.documents
        (id, tenant_id, home_id, uploader_user_id, workflow_id, object_key,
         original_filename, mime_type, size_bytes, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Care plan.pdf', 'application/pdf', 128,
               'uploaded'::"core"."DocumentStatus", now())`,
      [
        documentId,
        tenantId,
        homeAId,
        userId,
        `doc-ingest-${documentId}`,
        `tenants/${tenantId}/homes/${homeAId}/documents/${documentId}/Care-plan.pdf`,
      ],
    );
    const visibleA = await app.query<{ id: string }>('SELECT id::text FROM core.documents');
    expect(visibleA.rows.map((row) => row.id)).toEqual([documentId]);

    await setContext(app, homeBId);
    const visibleB = await app.query<{ id: string }>('SELECT id::text FROM core.documents');
    expect(visibleB.rows).toEqual([]);
    await app.query('COMMIT');

    const audit = await admin.query<{ action: string }>(
      `SELECT action FROM audit.events
       WHERE subject_type = 'document' AND subject_id = $1::uuid`,
      [documentId],
    );
    expect(audit.rows.map((row) => row.action)).toContain('document.registered');
  });
});

async function setContext(client: Client, homeId: string): Promise<void> {
  await client.query(
    `SELECT
       set_config('app.current_tenant_id', $1, true),
       set_config('app.current_home_id', $2, true),
       set_config('app.current_actor_kind', 'user', true),
       set_config('app.current_actor_user_id', $3, true),
       set_config('app.current_correlation_id', 'documents-migration-test', true),
       set_config('app.current_agent_run_id', '', true),
       set_config('app.current_prompt_hash', '', true)`,
    [tenantId, homeId, userId],
  );
}

function postgresUrl(user: string, password: string, container: StartedTestContainer): string {
  const host = container.getHost() === 'localhost' ? '127.0.0.1' : container.getHost();
  return `postgresql://${user}:${password}@${host}:${container.getMappedPort(5432)}/careos?schema=public`;
}
