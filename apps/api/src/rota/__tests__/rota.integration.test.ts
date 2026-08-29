import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  rotaPublishWorkflowId,
  type RotaAnalysisResult,
  type RotaAnalyzeWorkflowInput,
  type RotaPublishStateQuery,
  type RotaPublishWorkflowInput,
} from '@careos/contracts';
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
import {
  TemporalService,
  type StartedRotaPublishWorkflow,
} from '../../temporal/temporal.service.js';

const runIntegration = process.env.CAREOS_RUN_PHASE2_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeAId = '22222222-2222-4222-8222-222222222222';
const homeBId = '33333333-3333-4333-8333-333333333333';
const managerUserId = '44444444-4444-4444-8444-444444444444';
const supportUserId = '55555555-5555-4555-8555-555555555555';
const shiftAId = '66666666-6666-4666-8666-666666666666';
const shiftBId = '77777777-7777-4777-8777-777777777777';
const ruleAId = '88888888-8888-4888-8888-888888888888';
const ruleBId = '99999999-9999-4999-8999-999999999999';

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
  readonly publishStarts: RotaPublishWorkflowInput[] = [];
  readonly analyzeCalls: RotaAnalyzeWorkflowInput[] = [];

  executeRotaAnalyzeWorkflow(input: RotaAnalyzeWorkflowInput): Promise<RotaAnalysisResult> {
    this.analyzeCalls.push(input);
    const result: RotaAnalysisResult = {
      correlationId: input.correlationId,
      gaps: [
        {
          detail: 'Shift needs 2 support_worker on duty; currently 1.',
          kind: 'min_staffing',
          ruleId: ruleAId,
          ruleName: 'Minimum support workers',
          severity: 'high',
          shiftId: shiftAId,
        },
      ],
      narration: 'Coverage gap detected on the morning shift.',
      periodEnd: input.periodEnd,
      periodStart: input.periodStart,
      proposals: [
        {
          addUserIds: [supportUserId],
          reason: 'covers minimum',
          removeUserIds: [],
          resolvedGapKinds: ['min_staffing'],
          shiftId: shiftAId,
        },
      ],
      shifts: [
        {
          assignedUserIds: [],
          endsAt: input.periodEnd,
          id: shiftAId,
          minHeadcount: 2,
          requiredRole: 'support_worker',
          startsAt: input.periodStart,
        },
      ],
    };
    return Promise.resolve(result);
  }

  startRotaPublishWorkflow(input: RotaPublishWorkflowInput): Promise<StartedRotaPublishWorkflow> {
    this.publishStarts.push(input);
    return Promise.resolve({
      publicationId: input.publicationId,
      runId: 'run-id',
      taskQueue: 'careos.rota',
      workflowId: rotaPublishWorkflowId(input.publicationId),
    });
  }

  queryRotaPublishState(publicationId: string): Promise<RotaPublishStateQuery> {
    return Promise.resolve({ publicationId, publishedAssignmentIds: [], status: 'processing' });
  }
}

describeIntegration('rota API integration contracts', () => {
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
    await runMigration(admin, '0004_phase2_email_drafts/migration.sql');
    await runMigration(admin, '0005_phase2_approvals/migration.sql');
    await runMigration(admin, '0006_phase2_rota/migration.sql');
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

  it('returns rota overview scoped to the active home', async () => {
    const response = await injectJson<{
      readonly shifts: ReadonlyArray<{ readonly id: string }>;
      readonly rules: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    }>(
      'GET',
      `/rota?from=${encodeURIComponent('2026-05-18T00:00:00.000Z')}&to=${encodeURIComponent('2026-05-25T00:00:00.000Z')}`,
      authHeaders(homeAId),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.shifts.map((shift) => shift.id)).toEqual([shiftAId]);
    expect(response.body.rules.map((rule) => rule.id)).toEqual([ruleAId]);
  });

  it('rejects malformed analyze payloads at the Zod boundary', async () => {
    const response = await injectJson<Record<string, unknown>>(
      'POST',
      '/rota/analyze',
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-rota-bad' },
      { period_start: 'not-a-date', period_end: 'also-not' },
    );
    expect(response.statusCode).toBe(400);
    expect(temporal.analyzeCalls).toHaveLength(0);
  });

  it('synchronously returns gaps + proposals from POST /rota/analyze', async () => {
    const response = await injectJson<{
      readonly gaps: ReadonlyArray<{ readonly kind: string; readonly shiftId: string }>;
      readonly proposals: ReadonlyArray<{
        readonly shiftId: string;
        readonly addUserIds: readonly string[];
      }>;
      readonly narration: string;
    }>(
      'POST',
      '/rota/analyze',
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-rota-analyze' },
      {
        period_end: '2026-05-25T00:00:00.000Z',
        period_start: '2026-05-18T00:00:00.000Z',
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.gaps[0]).toMatchObject({ kind: 'min_staffing', shiftId: shiftAId });
    expect(response.body.proposals[0]).toMatchObject({
      addUserIds: [supportUserId],
      shiftId: shiftAId,
    });
    expect(temporal.analyzeCalls).toHaveLength(1);
  });

  it('requires manager or ops_admin to POST /rota/publish', async () => {
    const response = await injectJson<Record<string, unknown>>(
      'POST',
      '/rota/publish',
      {
        ...authHeaders(homeAId, 'support_worker', 'support-only'),
        'idempotency-key': 'idem-rota-rbac',
      },
      {
        period_end: '2026-05-25T00:00:00.000Z',
        period_start: '2026-05-18T00:00:00.000Z',
        shift_ids: [shiftAId],
      },
    );
    expect(response.statusCode).toBe(403);
    expect(temporal.publishStarts).toHaveLength(0);
  });

  it('starts a RotaPublishWorkflow for managers and returns 202', async () => {
    const response = await injectJson<{
      readonly publicationId: string;
      readonly workflowId: string;
      readonly status: string;
    }>(
      'POST',
      '/rota/publish',
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-rota-publish' },
      {
        note: 'Publishing the week.',
        period_end: '2026-05-25T00:00:00.000Z',
        period_start: '2026-05-18T00:00:00.000Z',
        shift_ids: [shiftAId],
      },
    );

    expect(response.statusCode).toBe(202);
    expect(response.body.status).toBe('processing');
    expect(temporal.publishStarts).toHaveLength(1);
    expect(temporal.publishStarts[0]).toMatchObject({
      homeId: homeAId,
      shiftIds: [shiftAId],
      tenantId,
    });
  });

  it('replays the same publish response without starting a second workflow', async () => {
    const headers = { ...authHeaders(homeAId), 'idempotency-key': 'idem-rota-replay' };
    const payload = {
      period_end: '2026-05-25T00:00:00.000Z',
      period_start: '2026-05-18T00:00:00.000Z',
      shift_ids: [shiftAId],
    };
    const startsBefore = temporal.publishStarts.length;

    const first = await injectJson<Record<string, unknown>>(
      'POST',
      '/rota/publish',
      headers,
      payload,
    );
    const second = await injectJson<Record<string, unknown>>(
      'POST',
      '/rota/publish',
      headers,
      payload,
    );

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(temporal.publishStarts).toHaveLength(startsBefore + 1);
  });

  it('creates a rota rule via POST /rota/rules and writes an append-only audit row', async () => {
    const before = await ruleAuditActions();

    const response = await injectJson<{ readonly id: string; readonly name: string }>(
      'POST',
      '/rota/rules',
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-rota-rule' },
      {
        active: true,
        kind: 'qualification_flag',
        name: 'Medication trained on duty',
        parameters: { requireFlag: 'medication' },
      },
    );

    expect(response.statusCode).toBe(201);
    expect(response.body.name).toBe('Medication trained on duty');

    const after = await ruleAuditActions();
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toContain('rota_rule.created');
  });

  it('enforces RLS isolation on core.rota_rules between homes', async () => {
    await expect(visibleRuleIds(homeAId)).resolves.toContain(ruleAId);
    await expect(visibleRuleIds(homeAId)).resolves.not.toContain(ruleBId);
    await expect(visibleRuleIds(homeBId)).resolves.toContain(ruleBId);
    await expect(visibleRuleIds(homeBId)).resolves.not.toContain(ruleAId);
  });

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

  async function visibleRuleIds(homeId: string): Promise<readonly string[]> {
    const rows = await prisma.withTenantContext(
      { actor: { kind: 'user' }, homeId, tenantId },
      (transaction) => transaction.$queryRaw<Array<{ readonly id: string }>>`
        SELECT id::text FROM core.rota_rules ORDER BY id
      `,
    );
    return rows.map((row) => row.id);
  }

  async function ruleAuditActions(): Promise<readonly string[]> {
    const result = await admin.query<{ readonly action: string }>(
      `SELECT action FROM audit.events WHERE subject_type = 'rota_rule' ORDER BY occurred_at, action`,
    );
    return result.rows.map((row) => row.action);
  }
});

function authHeaders(
  homeId: string,
  roles = 'manager,ops_admin',
  subject = `sub-rota-${homeId}`,
): Record<string, string> {
  return {
    authorization: 'Bearer test-token',
    'x-careos-correlation-id': `corr-rota-${homeId}`,
    'x-careos-home-id': homeId,
    'x-test-email': `${subject}@example.test`,
    'x-test-home-ids': `${homeAId},${homeBId}`,
    'x-test-roles': roles,
    'x-test-sub': subject,
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
      ('${managerUserId}', '${tenantId}', 'seed-manager', 'manager@example.test', 'Seed Manager',
       ARRAY['${homeAId}', '${homeBId}']::uuid[], ARRAY['manager','ops_admin'], now()),
      ('${supportUserId}', '${tenantId}', 'seed-support', 'support@example.test', 'Seed Support',
       ARRAY['${homeAId}']::uuid[], ARRAY['support_worker'], now());

    INSERT INTO core.shifts
      (id, tenant_id, home_id, starts_at, ends_at, required_role, min_headcount, updated_at)
    VALUES
      ('${shiftAId}', '${tenantId}', '${homeAId}', '2026-05-18T07:00:00Z', '2026-05-18T15:00:00Z',
       'support_worker', 2, now()),
      ('${shiftBId}', '${tenantId}', '${homeBId}', '2026-05-19T07:00:00Z', '2026-05-19T15:00:00Z',
       'support_worker', 2, now());

    INSERT INTO core.rota_rules
      (id, tenant_id, home_id, name, kind, parameters, active, created_at, updated_at)
    VALUES
      ('${ruleAId}', '${tenantId}', '${homeAId}', 'Minimum support workers',
       'min_staffing'::"core"."RotaRuleKind",
       '{"minHeadcount":2,"requiredRole":"support_worker"}'::jsonb, true, now(), now()),
      ('${ruleBId}', '${tenantId}', '${homeBId}', 'Birch minimum support',
       'min_staffing'::"core"."RotaRuleKind",
       '{"minHeadcount":2,"requiredRole":"support_worker"}'::jsonb, true, now(), now());
  `);
}
