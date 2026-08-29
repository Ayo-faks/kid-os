import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../prisma/migrations/0001_init/migration.sql',
);

const tenantId = '11111111-1111-4111-8111-111111111111';
const ashHomeId = '22222222-2222-4222-8222-222222222222';
const birchHomeId = '33333333-3333-4333-8333-333333333333';
const ashResidentId = '44444444-4444-4444-8444-444444444444';
const birchResidentId = '55555555-5555-4555-8555-555555555555';
const subjectId = '66666666-6666-4666-8666-666666666666';

function requireDatabaseUrl(): string {
  if (databaseUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required for bootstrap migration tests.');
  }

  return databaseUrl;
}

function psql(args: string[]): string {
  return execFileSync('psql', [requireDatabaseUrl(), '--set', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
  });
}

function sql(command: string): string {
  return psql(['--quiet', '--tuples-only', '--no-align', '--command', command]);
}

function sqlFailure(command: string): SpawnSyncReturns<string> {
  return spawnSync(
    'psql',
    [requireDatabaseUrl(), '--set', 'ON_ERROR_STOP=1', '--quiet', '--command', command],
    { encoding: 'utf8' },
  );
}

function rows(output: string): string[] {
  return output
    .split('\n')
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
}

describeWithDatabase('Phase 0 bootstrap migration', () => {
  beforeAll(() => {
    sql(`
      DROP SCHEMA IF EXISTS audit CASCADE;
      DROP SCHEMA IF EXISTS core CASCADE;
      DROP SCHEMA IF EXISTS vector CASCADE;
      DROP EXTENSION IF EXISTS vector CASCADE;
      DROP EXTENSION IF EXISTS pg_trgm CASCADE;
      DROP EXTENSION IF EXISTS pgcrypto CASCADE;
    `);

    psql(['--file', migrationPath]);

    sql(`
      SET ROLE careos_app;
      SET app.current_tenant_id = '${tenantId}';
      SET app.current_home_id = '${ashHomeId}';

      INSERT INTO core.tenants (id, name, updated_at)
      VALUES ('${tenantId}', 'CareOS', now());

      INSERT INTO core.homes (id, tenant_id, name, updated_at)
      VALUES ('${ashHomeId}', '${tenantId}', 'Ash House', now());

      INSERT INTO core.residents (
        id,
        tenant_id,
        home_id,
        first_name,
        last_name,
        date_of_birth,
        arrived_at,
        updated_at
      )
      VALUES (
        '${ashResidentId}',
        '${tenantId}',
        '${ashHomeId}',
        'Ash',
        'Resident',
        DATE '2010-01-01',
        now(),
        now()
      );

      SET app.current_home_id = '${birchHomeId}';

      INSERT INTO core.homes (id, tenant_id, name, updated_at)
      VALUES ('${birchHomeId}', '${tenantId}', 'Birch House', now());

      INSERT INTO core.residents (
        id,
        tenant_id,
        home_id,
        first_name,
        last_name,
        date_of_birth,
        arrived_at,
        updated_at
      )
      VALUES (
        '${birchResidentId}',
        '${tenantId}',
        '${birchHomeId}',
        'Birch',
        'Resident',
        DATE '2011-02-02',
        now(),
        now()
      );
    `);
  });

  it('isolates residents across home_id session GUC values', () => {
    const ashResidents = rows(
      sql(`
        SET ROLE careos_app;
        SET app.current_tenant_id = '${tenantId}';
        SET app.current_home_id = '${ashHomeId}';
        SELECT first_name FROM core.residents ORDER BY first_name;
      `),
    );

    const birchResidents = rows(
      sql(`
        SET ROLE careos_app;
        SET app.current_tenant_id = '${tenantId}';
        SET app.current_home_id = '${birchHomeId}';
        SELECT first_name FROM core.residents ORDER BY first_name;
      `),
    );

    expect(ashResidents).toEqual(['Ash']);
    expect(birchResidents).toEqual(['Birch']);
  });

  it('raises on UPDATE and DELETE against audit.events', () => {
    const [eventId] = rows(
      sql(`
        SET ROLE careos_app;
        SET app.current_tenant_id = '${tenantId}';
        SET app.current_home_id = '${ashHomeId}';

        INSERT INTO audit.events (
          tenant_id,
          home_id,
          actor_kind,
          action,
          subject_type,
          subject_id,
          correlation_id
        )
        VALUES (
          '${tenantId}',
          '${ashHomeId}',
          'system',
          'bootstrap.test',
          'resident',
          '${subjectId}',
          'test-correlation-id'
        )
        RETURNING id;
      `),
    );

    const update = sqlFailure(`
      RESET ROLE;
      SET app.current_tenant_id = '${tenantId}';
      SET app.current_home_id = '${ashHomeId}';
      UPDATE audit.events SET action = 'bootstrap.changed' WHERE id = '${eventId}';
    `);

    const deleteResult = sqlFailure(`
      RESET ROLE;
      SET app.current_tenant_id = '${tenantId}';
      SET app.current_home_id = '${ashHomeId}';
      DELETE FROM audit.events WHERE id = '${eventId}';
    `);

    expect(update.status).not.toBe(0);
    expect(`${update.stdout}${update.stderr}`).toContain(
      'audit.events is append-only; UPDATE is not allowed',
    );
    expect(deleteResult.status).not.toBe(0);
    expect(`${deleteResult.stdout}${deleteResult.stderr}`).toContain(
      'audit.events is append-only; DELETE is not allowed',
    );
  });
});
