import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emailDraftWorkflowId, type EmailDraftWorkflowInput } from '@careos/contracts';
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
  type StartedEmailDraftWorkflow,
} from '../../temporal/temporal.service.js';

const runIntegration = process.env.CAREOS_RUN_PHASE2_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeAId = '22222222-2222-4222-8222-222222222222';
const homeBId = '33333333-3333-4333-8333-333333333333';
const userAId = '66666666-6666-4666-8666-666666666666';
const seededDraftAId = 'eeeeeee1-eeee-4eee-8eee-eeeeeeeeeeee';
const seededDraftBId = 'eeeeeee2-eeee-4eee-8eee-eeeeeeeeeeee';

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
    readonly input: Omit<EmailDraftWorkflowInput, 'emailDraftId'> & {
      readonly emailDraftId?: string;
    };
    readonly started: StartedEmailDraftWorkflow;
  }> = [];

  startEmailDraftWorkflow(
    input: Omit<EmailDraftWorkflowInput, 'emailDraftId'> & { readonly emailDraftId?: string },
  ): Promise<StartedEmailDraftWorkflow> {
    const emailDraftId = input.emailDraftId ?? 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const started: StartedEmailDraftWorkflow = {
      emailDraftId,
      runId: `run-${this.starts.length + 1}`,
      taskQueue: 'careos.emails.test',
      workflowId: emailDraftWorkflowId(emailDraftId),
    };
    this.starts.push({ input, started });
    return Promise.resolve(started);
  }
}

describeIntegration('email drafts API integration contracts', () => {
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

  it('POST /comms/email/draft starts an EmailDraftWorkflow with the controller payload', async () => {
    const response = await injectJson<{
      readonly id: string;
      readonly status: string;
      readonly workflowId: string;
    }>(
      'POST',
      '/comms/email/draft',
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-email-1' },
      {
        instructions: 'Inform the duty manager that the evening was calm.',
        recipient: { email: 'manager@example.com', role: 'manager' },
        source: { kind: 'handover', summary: 'Calm evening shift, no concerns to escalate.' },
      },
    );

    expect(response.statusCode).toBe(202);
    expect(response.body.status).toBe('processing');
    expect(temporal.starts).toHaveLength(1);

    const call = temporal.starts[0];
    expect(call?.input).toMatchObject({
      homeId: homeAId,
      instructions: 'Inform the duty manager that the evening was calm.',
      recipient: { email: 'manager@example.com', role: 'manager' },
      source: { kind: 'handover', summary: 'Calm evening shift, no concerns to escalate.' },
      tenantId,
    });
    expect(call?.input.authorUserId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.workflowId).toBe(emailDraftWorkflowId(response.body.id));
  });

  it('replays identical responses for the same Idempotency-Key', async () => {
    const headers = { ...authHeaders(homeAId), 'idempotency-key': 'idem-email-replay' };
    const payload = {
      instructions: 'Notify the registered manager that the medication log is up to date.',
      recipient: { email: 'manager@example.com' },
      source: { kind: 'general', summary: 'Routine medication log review completed.' },
    };

    const before = temporal.starts.length;
    const first = await injectJson<Record<string, unknown>>(
      'POST',
      '/comms/email/draft',
      headers,
      payload,
    );
    const second = await injectJson<Record<string, unknown>>(
      'POST',
      '/comms/email/draft',
      headers,
      payload,
    );

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(temporal.starts.length - before).toBe(1);
  });

  it('rejects malformed payloads at the Zod boundary', async () => {
    const response = await injectJson<Record<string, unknown>>(
      'POST',
      '/comms/email/draft',
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-email-bad' },
      {
        instructions: 'too short',
        recipient: { email: 'not-an-email' },
        source: { kind: 'general', summary: 'x' },
      },
    );

    expect(response.statusCode).toBe(400);
  });

  it('enforces RLS isolation on core.email_drafts between homes', async () => {
    const visibleA = await prisma.withTenantContext(
      { actor: { kind: 'user' }, homeId: homeAId, tenantId },
      (transaction) => transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM core.email_drafts ORDER BY id
      `,
    );
    expect(visibleA.map((row) => row.id)).toEqual([seededDraftAId]);

    const visibleB = await prisma.withTenantContext(
      { actor: { kind: 'user' }, homeId: homeBId, tenantId },
      (transaction) => transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id::text FROM core.email_drafts ORDER BY id
      `,
    );
    expect(visibleB.map((row) => row.id)).toEqual([seededDraftBId]);
  });

  it('writes append-only audit rows on email_draft INSERT and status transitions', async () => {
    const beforeRows = await admin.query<{ action: string }>(
      `SELECT action FROM audit.events WHERE subject_type = 'email_draft' AND subject_id = $1::uuid ORDER BY occurred_at, action`,
      [seededDraftAId],
    );
    expect(beforeRows.rows.map((row) => row.action)).toEqual(['email_draft.created']);

    await admin.query(
      `UPDATE core.email_drafts
          SET status = 'needs_review'::"core"."EmailDraftStatus", updated_at = now()
        WHERE id = $1::uuid`,
      [seededDraftAId],
    );

    const afterRows = await admin.query<{ action: string }>(
      `SELECT action FROM audit.events WHERE subject_type = 'email_draft' AND subject_id = $1::uuid ORDER BY occurred_at, action`,
      [seededDraftAId],
    );
    expect(afterRows.rows.map((row) => row.action)).toEqual([
      'email_draft.created',
      'email_draft.routed_for_review',
    ]);

    await expect(
      prisma.withTenantContext(
        { actor: { kind: 'user' }, homeId: homeAId, tenantId },
        (transaction) =>
          transaction.$executeRaw`UPDATE audit.events SET action = 'tampered' WHERE subject_id = ${seededDraftAId}::uuid`,
      ),
    ).rejects.toThrow(/permission denied|append-only|UPDATE/i);
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
    'x-careos-correlation-id': `corr-email-${homeId}`,
    'x-careos-home-id': homeId,
    'x-test-home-ids': `${homeAId},${homeBId}`,
    'x-test-roles': 'support_worker,shift_lead',
    'x-test-sub': `sub-email-${homeId}`,
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
       ARRAY['${homeAId}', '${homeBId}']::uuid[], ARRAY['support_worker', 'shift_lead'], now());

    INSERT INTO core.email_drafts (
      id, tenant_id, home_id, workflow_id, source_kind, source_summary,
      recipient_email, subject, body, sensitivity, sensitivity_reasons, status,
      created_by_user_id, created_at, updated_at
    ) VALUES
      ('${seededDraftAId}', '${tenantId}', '${homeAId}', 'email-draft-${seededDraftAId}',
       'general'::"core"."EmailSourceKind", 'Seed draft for Ash House',
       'manager@example.test', 'Ash routine update', 'Ash House body is more than twenty characters long.',
       'routine'::"core"."EmailSensitivity", '[]'::jsonb,
       'draft'::"core"."EmailDraftStatus", '${userAId}', now(), now()),
      ('${seededDraftBId}', '${tenantId}', '${homeBId}', 'email-draft-${seededDraftBId}',
       'general'::"core"."EmailSourceKind", 'Seed draft for Birch House',
       'manager@example.test', 'Birch routine update', 'Birch House body is more than twenty characters long.',
       'routine'::"core"."EmailSensitivity", '[]'::jsonb,
       'draft'::"core"."EmailDraftStatus", '${userAId}', now(), now());
  `);
}
