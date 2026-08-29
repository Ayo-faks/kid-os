import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;
const migrationsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const bootstrapMigration = resolve(migrationsRoot, '0001_init/migration.sql');
const phase1Migration = resolve(migrationsRoot, '0002_phase1_audit_triggers/migration.sql');

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const otherHomeId = '33333333-3333-4333-8333-333333333333';
const residentId = '44444444-4444-4444-8444-444444444444';
const userId = '77777777-7777-4777-8777-777777777777';
const formTemplateId = '88888888-8888-4888-8888-888888888888';
const incidentId = '99999999-9999-4999-8999-999999999999';
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const timelineId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const correlationId = 'phase1-trigger-test';

function requireDatabaseUrl(): string {
  if (databaseUrl === undefined) {
    throw new Error('TEST_DATABASE_URL is required for trigger tests.');
  }
  return databaseUrl;
}

function psql(args: string[]): string {
  return execFileSync('psql', [requireDatabaseUrl(), '--set', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
  });
}

function sql(command: string): string {
  return psql([
    '--quiet',
    '--tuples-only',
    '--no-align',
    '--field-separator',
    '|',
    '--command',
    command,
  ]);
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

// Sets every GUC the new audit triggers read.
function actorGucs(extra: Record<string, string> = {}): string {
  const base = {
    'app.current_tenant_id': tenantId,
    'app.current_home_id': homeId,
    'app.current_actor_kind': 'user',
    'app.current_actor_user_id': userId,
    'app.current_correlation_id': correlationId,
    ...extra,
  };
  return Object.entries(base)
    .map(([k, v]) => `SET ${k} = '${v}';`)
    .join('\n');
}

describeWithDatabase('Phase 1 audit triggers', () => {
  beforeAll(() => {
    sql(`
      DROP SCHEMA IF EXISTS audit CASCADE;
      DROP SCHEMA IF EXISTS core CASCADE;
      DROP SCHEMA IF EXISTS vector CASCADE;
      DROP EXTENSION IF EXISTS vector CASCADE;
      DROP EXTENSION IF EXISTS pg_trgm CASCADE;
      DROP EXTENSION IF EXISTS pgcrypto CASCADE;
    `);

    psql(['--file', bootstrapMigration]);
    psql(['--file', phase1Migration]);

    sql(`
      SET ROLE careos_app;
      ${actorGucs({ 'app.current_actor_kind': 'system', 'app.current_actor_user_id': '' })}

      INSERT INTO core.tenants (id, name, updated_at)
      VALUES ('${tenantId}', 'CareOS', now());

      INSERT INTO core.homes (id, tenant_id, name, updated_at)
      VALUES ('${homeId}', '${tenantId}', 'Ash House', now());

      SET app.current_home_id = '${otherHomeId}';
      INSERT INTO core.homes (id, tenant_id, name, updated_at)
      VALUES ('${otherHomeId}', '${tenantId}', 'Birch House', now());

      SET app.current_home_id = '${homeId}';

      INSERT INTO core.users (id, tenant_id, keycloak_sub, email, display_name, home_ids, roles, updated_at)
      VALUES (
        '${userId}', '${tenantId}', 'kc-sub-1', 'sw@example.test', 'Support Worker',
        ARRAY['${homeId}']::uuid[], ARRAY['support_worker'], now()
      );

      INSERT INTO core.residents (id, tenant_id, home_id, first_name, last_name, date_of_birth, arrived_at, updated_at)
      VALUES ('${residentId}', '${tenantId}', '${homeId}', 'Sample', 'Resident', DATE '2010-01-01', now(), now());

      INSERT INTO core.form_templates (id, tenant_id, template_id, version, title, schema, ui_schema)
      VALUES ('${formTemplateId}', '${tenantId}', 'incident.behavioural', 'v1', 'Behavioural Incident',
              '{}'::jsonb, '{}'::jsonb);
    `);
  });

  it('emits incident.created on insert with actor GUCs', () => {
    sql(`
      SET ROLE careos_app;
      ${actorGucs()}

      INSERT INTO core.incidents (
        id, tenant_id, home_id, resident_id, form_template_id,
        author_user_id, updated_at
      )
      VALUES (
        '${incidentId}', '${tenantId}', '${homeId}', '${residentId}', '${formTemplateId}',
        '${userId}', now()
      );
    `);

    const events = rows(
      sql(`
        SET ROLE careos_app;
        ${actorGucs()}
        SELECT action || '|' || actor_kind || '|' || COALESCE(actor_user_id::text, 'null') || '|' || COALESCE(correlation_id, 'null')
        FROM audit.events
        WHERE subject_type = 'incident' AND subject_id = '${incidentId}'
        ORDER BY occurred_at;
      `),
    );

    expect(events).toEqual([`incident.created|user|${userId}|${correlationId}`]);
  });

  it('emits incident.submitted/approved on status transitions', () => {
    sql(`
      SET ROLE careos_app;
      ${actorGucs()}
      UPDATE core.incidents SET status = 'awaiting_approval', updated_at = now() WHERE id = '${incidentId}';
      UPDATE core.incidents SET status = 'approved', updated_at = now() WHERE id = '${incidentId}';
    `);

    const events = rows(
      sql(`
        SET ROLE careos_app;
        ${actorGucs()}
        SELECT action FROM audit.events
        WHERE subject_type = 'incident' AND subject_id = '${incidentId}'
        ORDER BY occurred_at;
      `),
    );

    expect(events).toEqual(['incident.created', 'incident.submitted', 'incident.approved']);
  });

  it('emits incident_version.created with agent actor kind from GUCs', () => {
    sql(`
      SET ROLE careos_app;
      ${actorGucs({
        'app.current_actor_kind': 'agent',
        'app.current_actor_user_id': '',
        'app.current_agent_run_id': 'run-123',
        'app.current_prompt_hash': 'sha256:deadbeef',
      })}

      INSERT INTO core.incident_versions (
        id, tenant_id, home_id, incident_id, version, status,
        form_data, missing_mandatory, actor_kind
      )
      VALUES (
        '${versionId}', '${tenantId}', '${homeId}', '${incidentId}', 1, 'draft',
        '{}'::jsonb, ARRAY[]::text[], 'agent'
      );
    `);

    const events = rows(
      sql(`
        SET ROLE careos_app;
        ${actorGucs()}
        SELECT actor_kind || '|' || COALESCE(agent_run_id, 'null') || '|' || COALESCE(prompt_hash, 'null')
        FROM audit.events
        WHERE subject_type = 'incident_version' AND subject_id = '${versionId}';
      `),
    );

    expect(events).toEqual(['agent|run-123|sha256:deadbeef']);
  });

  it('emits timeline.created and rejects UPDATE/DELETE on timeline_entries', () => {
    sql(`
      SET ROLE careos_app;
      ${actorGucs()}

      INSERT INTO core.timeline_entries (
        id, tenant_id, home_id, resident_id, kind, occurred_at, summary, incident_id, actor_kind, actor_user_id
      )
      VALUES (
        '${timelineId}', '${tenantId}', '${homeId}', '${residentId}', 'incident', now(),
        'Behavioural incident logged', '${incidentId}', 'user', '${userId}'
      );
    `);

    const created = rows(
      sql(`
        SET ROLE careos_app;
        ${actorGucs()}
        SELECT action FROM audit.events
        WHERE subject_type = 'timeline_entry' AND subject_id = '${timelineId}';
      `),
    );
    expect(created).toEqual(['timeline.created']);

    const update = sqlFailure(`
      SET ROLE careos_app;
      ${actorGucs()}
      UPDATE core.timeline_entries SET summary = 'Edited' WHERE id = '${timelineId}';
    `);
    expect(update.status).not.toBe(0);
    expect(`${update.stdout}${update.stderr}`).toContain(
      'core.timeline_entries is append-only; UPDATE is not allowed',
    );

    const del = sqlFailure(`
      SET ROLE careos_app;
      ${actorGucs()}
      DELETE FROM core.timeline_entries WHERE id = '${timelineId}';
    `);
    expect(del.status).not.toBe(0);
    expect(`${del.stdout}${del.stderr}`).toContain(
      'core.timeline_entries is append-only; DELETE is not allowed',
    );
  });

  it('defaults actor_kind to system when GUC is unset', () => {
    const otherIncidentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    sql(`
      SET ROLE careos_app;
      SET app.current_tenant_id = '${tenantId}';
      SET app.current_home_id = '${homeId}';
      RESET app.current_actor_kind;
      RESET app.current_actor_user_id;
      RESET app.current_correlation_id;

      INSERT INTO core.incidents (
        id, tenant_id, home_id, resident_id, form_template_id,
        author_user_id, updated_at
      )
      VALUES (
        '${otherIncidentId}', '${tenantId}', '${homeId}', '${residentId}', '${formTemplateId}',
        '${userId}', now()
      );
    `);

    const actor = rows(
      sql(`
        SET ROLE careos_app;
        ${actorGucs()}
        SELECT actor_kind FROM audit.events
        WHERE subject_type = 'incident' AND subject_id = '${otherIncidentId}';
      `),
    );
    expect(actor).toEqual(['system']);
  });
});
