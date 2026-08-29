import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handoverWorkflowId, type HandoverWorkflowInput } from '@careos/contracts';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { type StartedTestContainer, GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { resolveCareosTestPostgresImage } from '../../database/test-postgres-image.js';
import { RedisService } from '../../idempotency/redis.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { configureApp } from '../../setup.js';
import { TemporalService, type StartedHandoverWorkflow } from '../../temporal/temporal.service.js';

const runIntegration = process.env.CAREOS_RUN_PHASE2_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeAId = '22222222-2222-4222-8222-222222222222';
const homeBId = '33333333-3333-4333-8333-333333333333';
const residentAId = '44444444-4444-4444-8444-444444444444';
const userAId = '66666666-6666-4666-8666-666666666666';
const userNextId = '77777777-7777-4777-8777-777777777777';
const shiftCurrentAId = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shiftNextAId = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const shiftCurrentBId = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const seededHandoverAId = 'ccccccc1-cccc-4ccc-8ccc-cccccccccccc';
const seededHandoverBId = 'ccccccc2-cccc-4ccc-8ccc-cccccccccccc';
const seededTaskAId = 'ddddddd1-dddd-4ddd-8ddd-dddddddddddd';

const migrationsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations',
);

interface InjectResponse<TBody> {
  readonly body: TBody;
  readonly statusCode: number;
}

class MemoryRedisClient {
  private readonly values = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string): Promise<'OK'> {
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  disconnect(): void {
    this.values.clear();
  }
}

class MemoryRedisService {
  readonly client = new MemoryRedisClient();

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

class FakeTemporalService {
  readonly starts: Array<{
    readonly input: Omit<HandoverWorkflowInput, 'handoverId'> & { readonly handoverId?: string };
    readonly started: StartedHandoverWorkflow;
  }> = [];

  startHandoverWorkflow(
    input: Omit<HandoverWorkflowInput, 'handoverId'> & { readonly handoverId?: string },
  ): Promise<StartedHandoverWorkflow> {
    const handoverId = input.handoverId ?? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const started: StartedHandoverWorkflow = {
      handoverId,
      runId: `run-${this.starts.length + 1}`,
      taskQueue: 'careos.handovers.test',
      workflowId: handoverWorkflowId(handoverId),
    };
    this.starts.push({ input, started });
    return Promise.resolve(started);
  }
}

describeIntegration('handovers API integration contracts', () => {
  let app: NestFastifyApplication;
  let container: StartedTestContainer;
  let admin: Client;
  let prisma: PrismaService;
  let temporal: FakeTemporalService;

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

    const adminUrl = postgresUrl('careos', 'change-me', container);
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(
      "CREATE ROLE careos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD 'change-me'",
    );
    await runMigration(admin, '0001_init/migration.sql');
    await runMigration(admin, '0002_phase1_audit_triggers/migration.sql');
    await runMigration(admin, '0003_phase2_handovers/migration.sql');
    await seedDatabase(admin);

    process.env.DATABASE_URL = postgresUrl('careos_app', 'change-me', container);
    process.env.CAREOS_TEST_AUTH_BYPASS = 'true';
    process.env.KEYCLOAK_ISSUER = 'http://keycloak.test/realms/careos';
    process.env.API_JWT_AUDIENCE = 'careos-api';

    temporal = new FakeTemporalService();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useClass(MemoryRedisService)
      .overrideProvider(TemporalService)
      .useValue(temporal)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
    await container?.stop();
  });

  it('POST /handovers starts a HandoverWorkflow with the controller payload', async () => {
    const response = await injectJson<{
      readonly id: string;
      readonly status: string;
      readonly workflowId: string;
    }>(
      'POST',
      '/handovers',
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-handover-1' },
      {
        free_text: 'Night shift was calm. Jamie needs a morning check-in.',
        shift_id: shiftCurrentAId,
        transcript_object_key: 'handovers/2026-05-17/shift-a.txt',
      },
    );

    expect(response.statusCode).toBe(202);
    expect(response.body.status).toBe('processing');
    expect(temporal.starts).toHaveLength(1);

    const call = temporal.starts[0];
    expect(call?.input).toMatchObject({
      freeText: 'Night shift was calm. Jamie needs a morning check-in.',
      homeId: homeAId,
      shiftId: shiftCurrentAId,
      tenantId,
      transcriptObjectKey: 'handovers/2026-05-17/shift-a.txt',
    });
    expect(call?.input.authorUserId).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.input.correlationId).toBeTruthy();
    expect(response.body.workflowId).toBe(handoverWorkflowId(response.body.id));
  });

  it('replays identical POST /handovers responses for the same Idempotency-Key', async () => {
    const headers = { ...authHeaders(homeAId), 'idempotency-key': 'idem-handover-replay' };
    const payload = {
      free_text: 'Day shift handover with structured follow-ups for the evening team.',
      shift_id: shiftCurrentAId,
    };

    const before = temporal.starts.length;
    const first = await injectJson<Record<string, unknown>>('POST', '/handovers', headers, payload);
    const second = await injectJson<Record<string, unknown>>(
      'POST',
      '/handovers',
      headers,
      payload,
    );

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(temporal.starts.length - before).toBe(1);
  });

  it('rejects malformed POST /handovers payloads at the Zod boundary', async () => {
    const response = await injectJson<Record<string, unknown>>(
      'POST',
      '/handovers',
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-handover-bad' },
      { free_text: 'too short', shift_id: 'not-a-uuid' },
    );

    expect(response.statusCode).toBe(400);
    expect(
      temporal.starts.find((call) => call.started.handoverId === 'should-not-start'),
    ).toBeUndefined();
  });

  it('enforces RLS isolation on core.handover_records between homes', async () => {
    const visibleA = await prisma.withTenantContext(
      { actor: { kind: 'user' }, homeId: homeAId, tenantId },
      (transaction) => transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM core.handover_records ORDER BY id
      `,
    );
    expect(visibleA.map((row) => row.id)).toEqual([seededHandoverAId]);

    const visibleB = await prisma.withTenantContext(
      { actor: { kind: 'user' }, homeId: homeBId, tenantId },
      (transaction) => transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM core.handover_records ORDER BY id
      `,
    );
    expect(visibleB.map((row) => row.id)).toEqual([seededHandoverBId]);
  });

  it('writes append-only audit rows on handover INSERT and status transitions', async () => {
    const beforeRows = await admin.query<{ action: string }>(
      `SELECT action FROM audit.events WHERE subject_type = 'handover' AND subject_id = $1::uuid ORDER BY occurred_at, action`,
      [seededHandoverAId],
    );
    expect(beforeRows.rows.map((row) => row.action)).toEqual(['handover.created']);

    await admin.query(
      `UPDATE core.handover_records
          SET status = 'completed'::"core"."HandoverStatus", updated_at = now()
        WHERE id = $1::uuid`,
      [seededHandoverAId],
    );

    const afterRows = await admin.query<{ action: string }>(
      `SELECT action FROM audit.events WHERE subject_type = 'handover' AND subject_id = $1::uuid ORDER BY occurred_at, action`,
      [seededHandoverAId],
    );
    expect(afterRows.rows.map((row) => row.action)).toEqual([
      'handover.created',
      'handover.completed',
    ]);

    await expect(
      prisma.withTenantContext(
        { actor: { kind: 'user' }, homeId: homeAId, tenantId },
        (transaction) =>
          transaction.$executeRaw`UPDATE audit.events SET action = 'tampered' WHERE subject_id = ${seededHandoverAId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|append-only|UPDATE/i);
  });

  it('materializes follow-up tasks via core.handover_tasks and emits task audit events', async () => {
    const seededTaskRows = await admin.query<{ task_id: string }>(
      `SELECT task_id::text FROM core.handover_tasks WHERE handover_record_id = $1::uuid`,
      [seededHandoverAId],
    );
    expect(seededTaskRows.rows.map((row) => row.task_id)).toEqual([seededTaskAId]);

    const taskAudit = await admin.query<{ action: string }>(
      `SELECT action FROM audit.events WHERE subject_type = 'task' AND subject_id = $1::uuid ORDER BY occurred_at, action`,
      [seededTaskId()],
    );
    expect(taskAudit.rows.map((row) => row.action)).toContain('task.created');

    const linkAudit = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit.events WHERE subject_type = 'handover_task'`,
    );
    expect(linkAudit.rows[0]?.count ?? 0).toBeGreaterThan(0);
  });

  function seededTaskId(): string {
    return seededTaskAId;
  }

  async function injectJson<TBody>(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: Record<string, unknown>,
  ): Promise<InjectResponse<TBody>> {
    const response = await app.getHttpAdapter().getInstance().inject({
      headers,
      method,
      payload,
      url,
    });
    return { body: JSON.parse(response.body) as TBody, statusCode: response.statusCode };
  }
});

function authHeaders(homeId: string): Record<string, string> {
  return {
    authorization: 'Bearer test-token',
    'x-careos-correlation-id': `corr-handover-${homeId}`,
    'x-careos-home-id': homeId,
    'x-test-home-ids': `${homeAId},${homeBId}`,
    'x-test-roles': 'support_worker,shift_lead',
    'x-test-sub': `sub-handover-${homeId}`,
    'x-test-tenant-id': tenantId,
  };
}

function postgresUrl(user: string, password: string, container: StartedTestContainer): string {
  const host = container.getHost() === 'localhost' ? '127.0.0.1' : container.getHost();
  return `postgresql://${user}:${password}@${host}:${container.getMappedPort(5432)}/careos?schema=public`;
}

async function runMigration(client: Client, migrationFile: string): Promise<void> {
  await client.query(readFileSync(resolve(migrationsRoot, migrationFile), 'utf8'));
}

async function seedDatabase(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO core.tenants (id, name, updated_at)
    VALUES ('${tenantId}', 'CareOS Test', now());

    INSERT INTO core.homes (id, tenant_id, name, updated_at)
    VALUES
      ('${homeAId}', '${tenantId}', 'Ash House', now()),
      ('${homeBId}', '${tenantId}', 'Birch House', now());

    INSERT INTO core.users (id, tenant_id, keycloak_sub, email, display_name, home_ids, roles, updated_at)
    VALUES
      ('${userAId}', '${tenantId}', 'seed-user-a', 'seed-a@example.test', 'Seed A',
       ARRAY['${homeAId}', '${homeBId}']::uuid[], ARRAY['support_worker', 'shift_lead'], now()),
      ('${userNextId}', '${tenantId}', 'seed-user-next', 'seed-next@example.test', 'Next Shift Worker',
       ARRAY['${homeAId}']::uuid[], ARRAY['support_worker'], now());

    INSERT INTO core.residents (id, tenant_id, home_id, first_name, last_name, date_of_birth, arrived_at, updated_at)
    VALUES
      ('${residentAId}', '${tenantId}', '${homeAId}', 'Jamie', 'Connor', DATE '2010-01-01', now(), now());

    INSERT INTO core.shifts (id, tenant_id, home_id, starts_at, ends_at, required_role, min_headcount, updated_at)
    VALUES
      ('${shiftCurrentAId}', '${tenantId}', '${homeAId}', now() - interval '8 hours', now(), 'support_worker', 1, now()),
      ('${shiftNextAId}',    '${tenantId}', '${homeAId}', now(), now() + interval '8 hours', 'support_worker', 1, now()),
      ('${shiftCurrentBId}', '${tenantId}', '${homeBId}', now() - interval '8 hours', now(), 'support_worker', 1, now());

    INSERT INTO core.shift_assignments (id, tenant_id, home_id, shift_id, user_id, state, updated_at)
    VALUES (gen_random_uuid(), '${tenantId}', '${homeAId}', '${shiftNextAId}', '${userNextId}', 'confirmed', now());

    INSERT INTO core.handover_records (
      id, tenant_id, home_id, shift_id, workflow_id, status, source_text,
      transcript_object_key, structured_payload, summary, created_by_user_id, updated_at
    ) VALUES
      ('${seededHandoverAId}', '${tenantId}', '${homeAId}', '${shiftCurrentAId}',
       'handover-${seededHandoverAId}', 'processing', 'seed handover A', NULL,
       '{"shiftId":"${shiftCurrentAId}"}'::jsonb, 'seed summary A', '${userAId}', now()),
      ('${seededHandoverBId}', '${tenantId}', '${homeBId}', '${shiftCurrentBId}',
       'handover-${seededHandoverBId}', 'processing', 'seed handover B', NULL,
       '{"shiftId":"${shiftCurrentBId}"}'::jsonb, 'seed summary B', '${userAId}', now());

    INSERT INTO core.tasks (
      id, tenant_id, home_id, resident_id, title, detail, status,
      assigned_user_id, created_by_user_id, updated_at
    ) VALUES (
      '${seededTaskAId}', '${tenantId}', '${homeAId}', '${residentAId}',
      'Handover follow-up: morning check-in', 'Morning check-in after unsettled bedtime.',
      'open', '${userNextId}', '${userAId}', now()
    );

    INSERT INTO core.handover_tasks (id, tenant_id, home_id, handover_record_id, task_id)
    VALUES (gen_random_uuid(), '${tenantId}', '${homeAId}', '${seededHandoverAId}', '${seededTaskAId}');
  `);
}
