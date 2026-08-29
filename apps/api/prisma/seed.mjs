#!/usr/bin/env node
// Deterministic demo seed for local/test bootstrap.
//
// - Gated by CAREOS_SEED_DEMO=true; exits 0 without touching the DB otherwise,
//   so production stacks can run the same job definition safely.
// - Idempotent: every write is an ON CONFLICT upsert keyed on deterministic
//   UUIDs from prisma/seed-data.json (shared with the Keycloak realm import
//   and the realm-parity contract test).
// - Runs on MIGRATION_DATABASE_URL (schema owner). Sets the app.* GUCs per
//   transaction anyway so audit triggers record a correct system actor.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

if (process.env.CAREOS_SEED_DEMO !== 'true') {
  console.log('[seed] CAREOS_SEED_DEMO is not "true" — skipping demo seed.');
  process.exit(0);
}

const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[seed] MIGRATION_DATABASE_URL or DATABASE_URL is required.');
  process.exit(1);
}

const seed = JSON.parse(readFileSync(resolve(here, 'seed-data.json'), 'utf8'));

// Form templates ship in @careos/schemas; resolve its schemas directory from
// the workspace layout (works in the repo and in the container image).
const schemasDir = resolve(here, '..', '..', '..', 'packages', 'schemas', 'schemas');

const FORM_TEMPLATES = [
  { id: 'incident.behavioural', version: 'v1', title: 'Behavioural Incident' },
  { id: 'incident.safeguarding', version: 'v1', title: 'Safeguarding Incident' },
  { id: 'incident.medication-near-miss', version: 'v1', title: 'Medication Near-Miss' },
  { id: 'handover.shift-end', version: 'v1', title: 'Shift-End Handover' },
  { id: 'note.observation', version: 'v1', title: 'Observation Note' },
  { id: 'comms.email-draft', version: 'v1', title: 'Email Draft' },
];

function loadTemplateJson(templateId, version) {
  const schema = JSON.parse(
    readFileSync(resolve(schemasDir, `${templateId}.${version}.schema.json`), 'utf8'),
  );
  const uiSchema = JSON.parse(
    readFileSync(resolve(schemasDir, `${templateId}.${version}.ui.json`), 'utf8'),
  );
  return { schema, uiSchema };
}

const client = new pg.Client({ connectionString });

async function withContext(homeId, fn) {
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT
         set_config('app.current_tenant_id', $1, true),
         set_config('app.current_home_id', $2, true),
         set_config('app.current_actor_kind', 'system', true),
         set_config('app.current_actor_user_id', '', true),
         set_config('app.current_correlation_id', 'seed-demo', true),
         set_config('app.current_agent_run_id', '', true),
         set_config('app.current_prompt_hash', '', true)`,
      [seed.tenant.id, homeId ?? ''],
    );
    await fn();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  await client.connect();

  await withContext(null, async () => {
    await client.query(
      `INSERT INTO core.tenants (id, name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
      [seed.tenant.id, seed.tenant.name],
    );
  });
  console.log(`[seed] tenant ${seed.tenant.name} (${seed.tenant.id})`);

  for (const home of seed.homes) {
    await withContext(home.id, async () => {
      await client.query(
        `INSERT INTO core.homes (id, tenant_id, name, ofsted_urn, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name, ofsted_urn = EXCLUDED.ofsted_urn, updated_at = NOW()`,
        [home.id, seed.tenant.id, home.name, home.ofstedUrn],
      );
    });
    console.log(`[seed] home ${home.name} (${home.id})`);
  }

  for (const user of seed.users) {
    await withContext(null, async () => {
      await client.query(
        `INSERT INTO core.users
           (id, tenant_id, keycloak_sub, email, display_name, home_ids, roles,
            qualifications, gender, disabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $9, false, NOW(), NOW())
         ON CONFLICT (keycloak_sub) DO UPDATE SET
           email = EXCLUDED.email,
           display_name = EXCLUDED.display_name,
           home_ids = EXCLUDED.home_ids,
           roles = EXCLUDED.roles,
           qualifications = EXCLUDED.qualifications,
           gender = EXCLUDED.gender,
           disabled = false,
           updated_at = NOW()`,
        [
          user.id,
          seed.tenant.id,
          user.keycloakSub,
          user.email,
          user.displayName,
          user.homeIds,
          user.roles,
          user.qualifications,
          user.gender,
        ],
      );
    });
    console.log(`[seed] user ${user.email} (${user.roles.join(',')})`);
  }

  for (const template of FORM_TEMPLATES) {
    const { schema, uiSchema } = loadTemplateJson(template.id, template.version);
    await withContext(null, async () => {
      await client.query(
        `INSERT INTO core.form_templates
           (id, tenant_id, template_id, version, title, schema, ui_schema, published_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
         ON CONFLICT (tenant_id, template_id, version) DO UPDATE SET
           title = EXCLUDED.title,
           schema = EXCLUDED.schema,
           ui_schema = EXCLUDED.ui_schema,
           retired_at = NULL`,
        [
          seed.tenant.id,
          template.id,
          template.version,
          template.title,
          JSON.stringify(schema),
          JSON.stringify(uiSchema),
        ],
      );
    });
    console.log(`[seed] form template ${template.id}@${template.version}`);
  }

  for (const resident of seed.residents) {
    await withContext(resident.homeId, async () => {
      await client.query(
        `INSERT INTO core.residents
           (id, tenant_id, home_id, first_name, last_name, preferred_name,
            date_of_birth, arrived_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::timestamptz, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           preferred_name = EXCLUDED.preferred_name,
           updated_at = NOW()`,
        [
          resident.id,
          seed.tenant.id,
          resident.homeId,
          resident.firstName,
          resident.lastName,
          resident.preferredName,
          resident.dateOfBirth,
          resident.arrivedAt,
        ],
      );
    });
    console.log(`[seed] resident ${resident.firstName} ${resident.lastName}`);
  }

  for (const rule of seed.rotaRules) {
    await withContext(rule.homeId, async () => {
      await client.query(
        `INSERT INTO core.rota_rules
           (id, tenant_id, home_id, name, kind, parameters, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::"core"."RotaRuleKind", $6::jsonb, true, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           parameters = EXCLUDED.parameters,
           active = true,
           updated_at = NOW()`,
        [
          rule.id,
          seed.tenant.id,
          rule.homeId,
          rule.name,
          rule.kind,
          JSON.stringify(rule.parameters),
        ],
      );
    });
    console.log(`[seed] rota rule ${rule.name}`);
  }

  for (const shift of seed.shifts) {
    const startsAt = new Date();
    startsAt.setUTCDate(startsAt.getUTCDate() + shift.daysFromNow);
    startsAt.setUTCHours(shift.startHourUtc, 0, 0, 0);
    const endsAt = new Date(startsAt.getTime() + shift.durationHours * 3600 * 1000);

    await withContext(shift.homeId, async () => {
      await client.query(
        `INSERT INTO core.shifts
           (id, tenant_id, home_id, starts_at, ends_at, required_role, min_headcount,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET
           starts_at = EXCLUDED.starts_at,
           ends_at = EXCLUDED.ends_at,
           required_role = EXCLUDED.required_role,
           min_headcount = EXCLUDED.min_headcount,
           updated_at = NOW()`,
        [
          shift.id,
          seed.tenant.id,
          shift.homeId,
          startsAt.toISOString(),
          endsAt.toISOString(),
          shift.requiredRole,
          shift.minHeadcount,
        ],
      );
      for (const userId of shift.assignedUserIds) {
        await client.query(
          `INSERT INTO core.shift_assignments
             (id, tenant_id, home_id, shift_id, user_id, state, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'confirmed', NOW(), NOW())
           ON CONFLICT (shift_id, user_id) DO UPDATE SET
             state = 'confirmed', updated_at = NOW()`,
          [seed.tenant.id, shift.homeId, shift.id, userId],
        );
      }
    });
    console.log(`[seed] shift ${shift.id} (${startsAt.toISOString()})`);
  }

  await client.end();
  console.log('[seed] demo seed complete.');
}

main().catch(async (error) => {
  console.error('[seed] FAILED:', error instanceof Error ? error.message : error);
  try {
    await client.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
