import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveCareosTestPostgresImage } from '../../src/database/test-postgres-image.js';

const runIntegration = process.env.CAREOS_RUN_PHASE4_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;
const bootstrapScript = resolve(dirname(fileURLToPath(import.meta.url)), '../azure-bootstrap.mjs');

function runBootstrap(env: Record<string, string>) {
  return spawnSync(process.execPath, [bootstrapScript], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

describeIntegration('azure-bootstrap provisions service database roles', () => {
  let container: StartedTestContainer;
  let admin: Client;
  let adminUrl: string;

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

    adminUrl = postgresUrl('careos', 'change-me', container);
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    for (const database of ['keycloak', 'temporal', 'temporal_visibility']) {
      await admin.query(`CREATE DATABASE ${database}`);
      const databaseAdmin = new Client({
        connectionString: postgresUrl('careos', 'change-me', container, database),
      });
      await databaseAdmin.connect();
      await databaseAdmin.query('ALTER SCHEMA public OWNER TO careos');
      await databaseAdmin.end();
    }
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await container?.stop();
  });

  it('fails closed when required environment is missing', () => {
    const result = runBootstrap({ MIGRATION_DATABASE_URL: '' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MIGRATION_DATABASE_URL is required');
  });

  it('creates login roles and reassigns database ownership on first run', async () => {
    const result = runBootstrap({
      CAREOS_APP_PASSWORD: 'app-secret-1',
      KEYCLOAK_DATABASE_PASSWORD: 'keycloak-secret-1',
      MIGRATION_DATABASE_URL: adminUrl,
      TEMPORAL_DATABASE_PASSWORD: 'temporal-secret-1',
    });
    expect(result.stderr).not.toContain('Error');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[database-bootstrap] service roles configured');

    const roles = await admin.query(
      `SELECT rolname, rolcanlogin, rolsuper
         FROM pg_roles
        WHERE rolname IN ('careos_app', 'careos_keycloak', 'careos_temporal')
        ORDER BY rolname`,
    );
    expect(roles.rows).toEqual([
      { rolcanlogin: true, rolname: 'careos_app', rolsuper: false },
      { rolcanlogin: true, rolname: 'careos_keycloak', rolsuper: false },
      { rolcanlogin: true, rolname: 'careos_temporal', rolsuper: false },
    ]);

    const owners = await admin.query(
      `SELECT d.datname, r.rolname AS owner
         FROM pg_database d
         JOIN pg_roles r ON r.oid = d.datdba
        WHERE d.datname IN ('keycloak', 'temporal', 'temporal_visibility')
        ORDER BY d.datname`,
    );
    expect(owners.rows).toEqual([
      { datname: 'keycloak', owner: 'careos_keycloak' },
      { datname: 'temporal', owner: 'careos_temporal' },
      { datname: 'temporal_visibility', owner: 'careos_temporal' },
    ]);

    const expectedSchemaOwners = [
      ['keycloak', 'careos_keycloak'],
      ['temporal', 'careos_temporal'],
      ['temporal_visibility', 'careos_temporal'],
    ];
    for (const [database, role] of expectedSchemaOwners) {
      const databaseAdmin = new Client({
        connectionString: postgresUrl('careos', 'change-me', container, database),
      });
      await databaseAdmin.connect();
      const schema = await databaseAdmin.query(
        `SELECT r.rolname AS owner,
                has_schema_privilege($1, 'public', 'CREATE') AS can_create,
                has_schema_privilege($1, 'public', 'USAGE') AS can_use
           FROM pg_namespace n
           JOIN pg_roles r ON r.oid = n.nspowner
          WHERE n.nspname = 'public'`,
        [role],
      );
      await databaseAdmin.end();
      expect(schema.rows[0]).toEqual({ can_create: true, can_use: true, owner: role });
    }

    const connect = await admin.query(
      `SELECT has_database_privilege('careos_app', 'careos', 'CONNECT') AS granted`,
    );
    expect(connect.rows[0]).toEqual({ granted: true });

    const appClient = new Client({
      connectionString: postgresUrl('careos_app', 'app-secret-1', container),
    });
    await appClient.connect();
    await appClient.end();
  });

  it('is idempotent and rotates passwords on re-run', async () => {
    const result = runBootstrap({
      CAREOS_APP_PASSWORD: 'app-secret-2',
      KEYCLOAK_DATABASE_PASSWORD: 'keycloak-secret-2',
      MIGRATION_DATABASE_URL: adminUrl,
      TEMPORAL_DATABASE_PASSWORD: 'temporal-secret-2',
    });
    expect(result.stderr).not.toContain('Error');
    expect(result.status).toBe(0);

    const rotated = new Client({
      connectionString: postgresUrl('careos_app', 'app-secret-2', container),
    });
    await rotated.connect();
    await rotated.end();
  });
});

function postgresUrl(
  user: string,
  password: string,
  container: StartedTestContainer,
  database = 'careos',
): string {
  const host = container.getHost() === 'localhost' ? '127.0.0.1' : container.getHost();
  return `postgresql://${user}:${password}@${host}:${container.getMappedPort(5432)}/${database}?schema=public`;
}
