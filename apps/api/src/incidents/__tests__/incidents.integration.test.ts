import 'reflect-metadata';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { incidentWorkflowId, type IncidentReportWorkflowInput } from '@careos/contracts';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { type StartedTestContainer, GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { applyAllPrismaMigrations } from '../../database/prisma-migration-test-harness.js';
import { resolveCareosTestPostgresImage } from '../../database/test-postgres-image.js';
import { RedisService } from '../../idempotency/redis.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { configureApp } from '../../setup.js';
import { TemporalService, type StartedIncidentWorkflow } from '../../temporal/temporal.service.js';

const runIntegration = process.env.CAREOS_RUN_PHASE1_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeAId = '22222222-2222-4222-8222-222222222222';
const homeBId = '33333333-3333-4333-8333-333333333333';
const residentAId = '44444444-4444-4444-8444-444444444444';
const residentBId = '55555555-5555-4555-8555-555555555555';
const userAId = '66666666-6666-4666-8666-666666666666';
const formTemplateId = '77777777-7777-4777-8777-777777777777';
const incidentAId = '88888888-8888-4888-8888-888888888888';
const incidentBId = '99999999-9999-4999-8999-999999999999';
const softDeletedIncidentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
const auditEventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

  set(key: string, value: string, ...args: readonly string[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.values.has(key)) {
      return Promise.resolve(null);
    }
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  eval(_script: string, _numberOfKeys: number, key: string, token: string): Promise<number> {
    if (this.values.get(key) === token) {
      this.values.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
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
  readonly starts: StartedIncidentWorkflow[] = [];

  startIncidentReportWorkflow(
    input: Omit<IncidentReportWorkflowInput, 'incidentId'> & { readonly incidentId?: string },
  ): Promise<StartedIncidentWorkflow> {
    const incidentId = input.incidentId ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const started = {
      incidentId,
      runId: `run-${this.starts.length + 1}`,
      taskQueue: 'careos.incidents.test',
      workflowId: incidentWorkflowId(incidentId),
    } satisfies StartedIncidentWorkflow;
    this.starts.push(started);
    return Promise.resolve(started);
  }
}

describeIntegration('incidents API integration contracts', () => {
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
    await applyAllPrismaMigrations(admin, migrationsRoot);
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

  it('enforces RLS between homes on incident reads', async () => {
    const own = await injectJson<Record<string, unknown>>(
      'GET',
      `/incidents/${incidentAId}`,
      authHeaders(homeAId),
    );
    expect(own.statusCode).toBe(200);
    expect(own.body.id).toBe(incidentAId);

    const crossHome = await injectJson<Record<string, unknown>>(
      'GET',
      `/incidents/${incidentBId}`,
      authHeaders(homeAId),
    );
    expect(crossHome.statusCode).toBe(404);
  });

  it('rejects invalid template/resident references before starting Temporal', async () => {
    const before = temporal.starts.length;
    const basePayload = { residentId: residentAId };

    const unknownTemplate = await injectJson<Record<string, unknown>>(
      'POST',
      '/incidents',
      { ...authHeaders(homeAId), 'idempotency-key': 'preflight-unknown-template' },
      {
        ...basePayload,
        formTemplate: { templateId: 'incident.unknown', version: 'v1' },
      },
    );
    expect(unknownTemplate.statusCode).toBe(400);

    const unregisteredTemplate = await injectJson<Record<string, unknown>>(
      'POST',
      '/incidents',
      { ...authHeaders(homeAId), 'idempotency-key': 'preflight-unregistered-template' },
      {
        ...basePayload,
        formTemplate: { templateId: 'incident.safeguarding', version: 'v1' },
      },
    );
    expect(unregisteredTemplate.statusCode).toBe(400);

    const crossHomeResident = await injectJson<Record<string, unknown>>(
      'POST',
      '/incidents',
      { ...authHeaders(homeAId), 'idempotency-key': 'preflight-cross-home-resident' },
      {
        formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
        residentId: residentBId,
      },
    );
    expect(crossHomeResident.statusCode).toBe(404);

    const malformedFormData = await injectJson<Record<string, unknown>>(
      'POST',
      '/incidents',
      { ...authHeaders(homeAId), 'idempotency-key': 'preflight-malformed-form-data' },
      {
        formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
        initialFormData: { occurredAt: 'not-a-date', rogueField: true },
        residentId: residentAId,
      },
    );
    expect(malformedFormData.statusCode).toBe(400);

    expect(temporal.starts).toHaveLength(before);
  });

  it('keeps alternating home-scoped reads isolated under pool pressure', async () => {
    const responses = await Promise.all(
      Array.from({ length: 24 }, (_, index) => {
        const useHomeA = index % 2 === 0;
        return injectJson<Record<string, unknown>>(
          'GET',
          `/incidents/${useHomeA ? incidentAId : incidentBId}`,
          authHeaders(useHomeA ? homeAId : homeBId),
        );
      }),
    );

    responses.forEach((response, index) => {
      expect(response.statusCode).toBe(200);
      expect(response.body.id).toBe(index % 2 === 0 ? incidentAId : incidentBId);
    });

    const denied = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        injectJson<Record<string, unknown>>(
          'GET',
          `/incidents/${index % 2 === 0 ? incidentBId : incidentAId}`,
          authHeaders(index % 2 === 0 ? homeAId : homeBId),
        ),
      ),
    );
    expect(denied.every((response) => response.statusCode === 404)).toBe(true);
  });

  it('reports template identity under RLS and excludes soft-deleted incidents', async () => {
    await admin.query(
      `INSERT INTO core.incidents
         (id, tenant_id, home_id, resident_id, form_template_id, workflow_id,
          author_user_id, soft_deleted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::uuid, now(), now())`,
      [
        softDeletedIncidentId,
        tenantId,
        homeAId,
        residentAId,
        formTemplateId,
        `incident-${softDeletedIncidentId}`,
        userAId,
      ],
    );

    const homeA = await prisma.withTenantContext(
      { actor: { kind: 'user' }, homeId: homeAId, tenantId },
      (transaction) => transaction.$queryRaw<Array<{ id: string; incident_type: string }>>`
        SELECT id::text, incident_type
        FROM core.v_incidents_reportable
        ORDER BY id
      `,
    );
    expect(homeA).toEqual([{ id: incidentAId, incident_type: 'incident.behavioural' }]);

    const homeB = await prisma.withTenantContext(
      { actor: { kind: 'user' }, homeId: homeBId, tenantId },
      (transaction) => transaction.$queryRaw<Array<{ id: string; incident_type: string }>>`
        SELECT id::text, incident_type
        FROM core.v_incidents_reportable
        ORDER BY id
      `,
    );
    expect(homeB).toEqual([{ id: incidentBId, incident_type: 'incident.behavioural' }]);
  });

  it('rejects UPDATE and DELETE against audit.events through the API Prisma client', async () => {
    await expect(
      prisma.withTenantContext(
        { actor: { kind: 'user' }, homeId: homeAId, tenantId },
        (transaction) =>
          transaction.$executeRaw`UPDATE audit.events SET action = 'tampered' WHERE id = ${auditEventId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|append-only|UPDATE/i);

    await expect(
      prisma.withTenantContext(
        { actor: { kind: 'user' }, homeId: homeAId, tenantId },
        (transaction) =>
          transaction.$executeRaw`DELETE FROM audit.events WHERE id = ${auditEventId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|append-only|DELETE/i);
  });

  it('replays identical POST /incidents responses for the same Idempotency-Key', async () => {
    const payload = {
      formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
      initialFormData: { summary: 'Jamie became distressed in the lounge.' },
      residentId: residentAId,
    };
    const headers = { ...authHeaders(homeAId), 'idempotency-key': 'idem-create-incident-1' };

    const first = await injectJson<Record<string, unknown>>('POST', '/incidents', headers, payload);
    const second = await injectJson<Record<string, unknown>>(
      'POST',
      '/incidents',
      headers,
      payload,
    );

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(temporal.starts).toHaveLength(1);

    const rows = await prisma.withTenantContext(
      { actor: { kind: 'user' }, homeId: homeAId, tenantId },
      (transaction) => transaction.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM core.idempotency_keys
        WHERE tenant_id = ${tenantId}::uuid AND key = 'idem-create-incident-1'
      `,
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('returns conflict when an Idempotency-Key is reused with a different body', async () => {
    const headers = { ...authHeaders(homeAId), 'idempotency-key': 'idem-create-mismatch-1' };
    const first = await injectJson<Record<string, unknown>>('POST', '/incidents', headers, {
      formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
      initialFormData: { summary: 'First narrative.' },
      residentId: residentAId,
    });
    const mismatch = await injectJson<Record<string, unknown>>('POST', '/incidents', headers, {
      formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
      initialFormData: { summary: 'A different narrative.' },
      residentId: residentAId,
    });

    expect(first.statusCode).toBe(202);
    expect(mismatch.statusCode).toBe(409);
    expect(temporal.starts.filter((started) => started.incidentId === first.body.id)).toHaveLength(
      1,
    );
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
});

function authHeaders(homeId: string): Record<string, string> {
  return {
    authorization: 'Bearer test-token',
    'x-careos-correlation-id': `corr-${homeId}`,
    'x-careos-home-id': homeId,
    'x-test-home-ids': `${homeAId},${homeBId}`,
    'x-test-roles': 'support_worker,manager',
    'x-test-sub': `sub-${homeId}`,
    'x-test-tenant-id': tenantId,
  };
}

function postgresUrl(user: string, password: string, container: StartedTestContainer): string {
  const host = container.getHost() === 'localhost' ? '127.0.0.1' : container.getHost();
  return `postgresql://${user}:${password}@${host}:${container.getMappedPort(5432)}/careos?schema=public`;
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
    VALUES (
      '${userAId}', '${tenantId}', 'seed-user', 'seed@example.test', 'Seed User',
      ARRAY['${homeAId}', '${homeBId}']::uuid[], ARRAY['support_worker', 'manager'], now()
    );

    INSERT INTO core.residents (id, tenant_id, home_id, first_name, last_name, date_of_birth, arrived_at, updated_at)
    VALUES
      ('${residentAId}', '${tenantId}', '${homeAId}', 'Jamie', 'Connor', DATE '2010-01-01', now(), now()),
      ('${residentBId}', '${tenantId}', '${homeBId}', 'Sam', 'Taylor', DATE '2011-02-02', now(), now());

    INSERT INTO core.form_templates (id, tenant_id, template_id, version, title, schema, ui_schema)
    VALUES (
      '${formTemplateId}', '${tenantId}', 'incident.behavioural', 'v1', 'Behavioural Incident',
      '{"type":"object"}'::jsonb, '{}'::jsonb
    );

    INSERT INTO core.incidents (id, tenant_id, home_id, resident_id, form_template_id, workflow_id, author_user_id, updated_at)
    VALUES
      ('${incidentAId}', '${tenantId}', '${homeAId}', '${residentAId}', '${formTemplateId}', 'incident-${incidentAId}', '${userAId}', now()),
      ('${incidentBId}', '${tenantId}', '${homeBId}', '${residentBId}', '${formTemplateId}', 'incident-${incidentBId}', '${userAId}', now());

    INSERT INTO audit.events (id, tenant_id, home_id, actor_kind, actor_user_id, correlation_id, action, subject_type, subject_id)
    VALUES (
      '${auditEventId}', '${tenantId}', '${homeAId}', 'user', '${userAId}', 'corr-audit',
      'incident.created', 'incident', '${incidentAId}'
    );
  `);
}
