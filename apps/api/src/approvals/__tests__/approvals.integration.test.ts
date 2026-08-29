import 'reflect-metadata';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { approvalWorkflowId, type ApprovalDecisionSignal } from '@careos/contracts';
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
import { TemporalService } from '../../temporal/temporal.service.js';

const runIntegration = process.env.CAREOS_RUN_PHASE2_INTEGRATION === 'true';
const describeIntegration = runIntegration ? describe : describe.skip;

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeAId = '22222222-2222-4222-8222-222222222222';
const homeBId = '33333333-3333-4333-8333-333333333333';
const requesterUserId = '44444444-4444-4444-8444-444444444444';
const draftAId = '55555555-5555-4555-8555-555555555555';
const draftBId = '66666666-6666-4666-8666-666666666666';
const approvalAId = '77777777-7777-4777-8777-777777777777';
const approvalBId = '88888888-8888-4888-8888-888888888888';
const residentAId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const formTemplateId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const incidentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const incidentApprovalId = '12121212-1212-4212-8212-121212121212';
const auditApproveId = '99999999-9999-4999-8999-999999999999';
const auditRejectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const auditApproveDraftId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const auditRejectDraftId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const migrationsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../prisma/migrations',
);

interface InjectResponse<TBody> {
  readonly body: TBody;
  readonly statusCode: number;
}

interface ApprovalQueueResponse {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly title: string;
    readonly status: string;
    readonly emailDraft: {
      readonly recipientEmail: string;
      readonly sensitivity: string;
      readonly status: string;
      readonly subject: string;
    } | null;
    readonly incident: {
      readonly residentId: string;
      readonly residentName: string;
      readonly status: string;
      readonly templateId: string;
    } | null;
    readonly requiredRoles: readonly string[];
    readonly signaturesRequired: number;
    readonly signaturesRecorded: number;
    readonly currentUserHasSigned: boolean;
  }>;
}

class MemoryRedisClient {
  private readonly values = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  set(key: string, value: string, ...args: readonly string[]): Promise<'OK' | null> {
    if (args.includes('NX') && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    return Promise.resolve('OK');
  }

  eval(_script: string, _numberOfKeys: number, key: string, token: string): Promise<number> {
    if (this.values.get(key) !== token) return Promise.resolve(0);
    this.values.delete(key);
    return Promise.resolve(1);
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
  readonly decisions: Array<{
    readonly approvalId: string;
    readonly payload: ApprovalDecisionSignal;
  }> = [];

  signalApprovalDecision(approvalId: string, payload: ApprovalDecisionSignal): Promise<void> {
    this.decisions.push({ approvalId, payload });
    return Promise.resolve();
  }
}

describeIntegration('approvals API integration contracts', () => {
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

  it('lists pending sensitive email-draft approvals for managers', async () => {
    const response = await injectJson<ApprovalQueueResponse>(
      'GET',
      '/approvals',
      authHeaders(homeAId),
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.items.map((item) => item.id)).toContain(approvalAId);
    expect(response.body.items.map((item) => item.id)).not.toContain(approvalBId);
    expect(response.body.items.find((item) => item.id === approvalAId)).toMatchObject({
      emailDraft: {
        recipientEmail: 'manager@example.test',
        sensitivity: 'sensitive',
        status: 'needs_review',
        subject: 'Sensitive family update',
      },
      status: 'pending',
      subjectId: draftAId,
      subjectType: 'email_draft',
      requiredRoles: ['manager', 'safeguarding_lead'],
      currentUserHasSigned: false,
      signaturesRecorded: 0,
      signaturesRequired: 2,
    });
    expect(response.body.items.find((item) => item.id === incidentApprovalId)).toMatchObject({
      incident: {
        residentId: residentAId,
        status: 'awaiting_approval',
        templateId: 'incident.safeguarding',
      },
      subjectId: incidentId,
      subjectType: 'incident',
    });
  });

  it('enforces RLS isolation on core.approvals between homes', async () => {
    await expect(visibleApprovalIds(homeAId)).resolves.toContain(approvalAId);
    await expect(visibleApprovalIds(homeAId)).resolves.not.toContain(approvalBId);
    await expect(visibleApprovalIds(homeBId)).resolves.toContain(approvalBId);
    await expect(visibleApprovalIds(homeBId)).resolves.not.toContain(approvalAId);
  });

  it('rejects malformed decision payloads at the Zod boundary', async () => {
    const response = await injectJson<Record<string, unknown>>(
      'POST',
      `/approvals/${approvalAId}/approve`,
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-approval-bad' },
      { reason: '' },
    );

    expect(response.statusCode).toBe(400);
    expect(temporal.decisions).toHaveLength(0);
  });

  it('requires manager, safeguarding, or ops role for decisions', async () => {
    const response = await injectJson<Record<string, unknown>>(
      'POST',
      `/approvals/${approvalAId}/approve`,
      {
        ...authHeaders(homeAId, 'support_worker', 'support-only'),
        'idempotency-key': 'idem-approval-rbac',
      },
      {},
    );

    expect(response.statusCode).toBe(403);
    expect(temporal.decisions).toHaveLength(0);
  });

  it('rejects an authenticated approver who does not cover the required role', async () => {
    const response = await injectJson<Record<string, unknown>>(
      'POST',
      `/approvals/${auditApproveId}/approve`,
      {
        ...authHeaders(homeAId, 'safeguarding_lead', 'dsl-only'),
        'idempotency-key': 'idem-approval-role-mismatch',
      },
      {},
    );

    expect(response.statusCode).toBe(403);
    expect(temporal.decisions).toHaveLength(0);
  });

  it('routes the legacy incident approve endpoint through its generic approval', async () => {
    const response = await injectJson<{ readonly accepted: true; readonly workflowId: string }>(
      'POST',
      `/incidents/${incidentId}/approve`,
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-legacy-incident-approve' },
      { note: 'Reviewed through the compatibility endpoint.' },
    );

    expect(response).toMatchObject({
      body: { accepted: true, workflowId: approvalWorkflowId(incidentApprovalId) },
      statusCode: 202,
    });
    const legacyDecision = temporal.decisions.at(-1);
    expect(legacyDecision).toMatchObject({
      approvalId: incidentApprovalId,
      payload: {
        decision: 'approved',
        reason: 'Reviewed through the compatibility endpoint.',
      },
    });
    expect(legacyDecision?.payload.decidedByUserId).toBe(legacyDecision?.payload.actor.userId);
    expect(legacyDecision?.payload.decidedByUserId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('signals approve and reject decisions to the approval workflow', async () => {
    const approved = await injectJson<{ readonly accepted: true; readonly workflowId: string }>(
      'POST',
      `/approvals/${approvalAId}/approve`,
      { ...authHeaders(homeAId), 'idempotency-key': 'idem-approval-approve' },
      { reason: 'Ready for the record.' },
    );
    const rejected = await injectJson<{ readonly accepted: true; readonly workflowId: string }>(
      'POST',
      `/approvals/${approvalBId}/reject`,
      { ...authHeaders(homeBId), 'idempotency-key': 'idem-approval-reject' },
      { reason: 'Needs a rewrite.' },
    );

    expect(approved).toMatchObject({
      body: { accepted: true, workflowId: approvalWorkflowId(approvalAId) },
      statusCode: 202,
    });
    expect(rejected).toMatchObject({
      body: { accepted: true, workflowId: approvalWorkflowId(approvalBId) },
      statusCode: 202,
    });
    const decisions = temporal.decisions.slice(-2);
    expect(decisions).toEqual([
      expect.objectContaining({
        approvalId: approvalAId,
        payload: expect.objectContaining({ decision: 'approved', reason: 'Ready for the record.' }),
      }),
      expect.objectContaining({
        approvalId: approvalBId,
        payload: expect.objectContaining({ decision: 'rejected', reason: 'Needs a rewrite.' }),
      }),
    ]);
    for (const decision of decisions) {
      expect(decision.payload.decidedByUserId).toBe(decision.payload.actor.userId);
    }
  });

  it('writes append-only audit rows on approval create, approve, and reject', async () => {
    const before = await auditActions(auditApproveId);
    expect(before).toEqual(['approval.created']);

    await admin.query(
      `UPDATE core.approvals
          SET status = 'approved'::"core"."ApprovalStatus", decided_by_user_id = $2::uuid, decided_at = now(), updated_at = now()
        WHERE id = $1::uuid`,
      [auditApproveId, requesterUserId],
    );
    await admin.query(
      `UPDATE core.approvals
          SET status = 'rejected'::"core"."ApprovalStatus", decided_by_user_id = $2::uuid, decided_at = now(), updated_at = now()
        WHERE id = $1::uuid`,
      [auditRejectId, requesterUserId],
    );

    await expect(auditActions(auditApproveId)).resolves.toEqual([
      'approval.created',
      'approval.approved',
    ]);
    await expect(auditActions(auditRejectId)).resolves.toEqual([
      'approval.created',
      'approval.rejected',
    ]);
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

  async function visibleApprovalIds(homeId: string): Promise<readonly string[]> {
    const rows = await prisma.withTenantContext(
      { actor: { kind: 'user' }, homeId, tenantId },
      (transaction) => transaction.$queryRaw<Array<{ readonly id: string }>>`
        SELECT id::text FROM core.approvals ORDER BY id
      `,
    );
    return rows.map((row) => row.id);
  }

  async function auditActions(approvalId: string): Promise<readonly string[]> {
    const result = await admin.query<{ readonly action: string }>(
      `SELECT action FROM audit.events WHERE subject_type = 'approval' AND subject_id = $1::uuid ORDER BY occurred_at, action`,
      [approvalId],
    );
    return result.rows.map((row) => row.action);
  }
});

function authHeaders(
  homeId: string,
  roles = 'manager,safeguarding_lead',
  subject = `sub-approval-${homeId}`,
): Record<string, string> {
  return {
    authorization: 'Bearer test-token',
    'x-careos-correlation-id': `corr-approval-${homeId}`,
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
      ('${requesterUserId}', '${tenantId}', 'seed-requester', 'requester@example.test', 'Seed Requester',
       ARRAY['${homeAId}', '${homeBId}']::uuid[], ARRAY['support_worker'], now());

    INSERT INTO core.residents
      (id, tenant_id, home_id, first_name, last_name, preferred_name, date_of_birth, arrived_at, updated_at)
    VALUES
      ('${residentAId}', '${tenantId}', '${homeAId}', 'Jamie', 'Connor', 'Jamie', DATE '2010-01-01', now(), now());

    INSERT INTO core.form_templates
      (id, tenant_id, template_id, version, title, schema, ui_schema)
    VALUES
      ('${formTemplateId}', '${tenantId}', 'incident.safeguarding', 'v1', 'Safeguarding Incident', '{}'::jsonb, '{}'::jsonb);

    INSERT INTO core.incidents
      (id, tenant_id, home_id, resident_id, form_template_id, workflow_id, status, author_user_id, updated_at)
    VALUES
      ('${incidentId}', '${tenantId}', '${homeAId}', '${residentAId}', '${formTemplateId}', 'incident-${incidentId}',
       'awaiting_approval'::"core"."IncidentStatus", '${requesterUserId}', now());

    INSERT INTO core.email_drafts (
      id, tenant_id, home_id, workflow_id, source_kind, source_summary,
      recipient_email, subject, body, sensitivity, sensitivity_reasons, status,
      created_by_user_id, created_at, updated_at
    ) VALUES
      ('${draftAId}', '${tenantId}', '${homeAId}', 'email-draft-${draftAId}',
       'general'::"core"."EmailSourceKind", 'Sensitive Ash draft',
       'manager@example.test', 'Sensitive family update', 'This sensitive family update needs manager review before any outbound handling.',
       'sensitive'::"core"."EmailSensitivity", '["family contact"]'::jsonb,
       'needs_review'::"core"."EmailDraftStatus", '${requesterUserId}', now(), now()),
      ('${draftBId}', '${tenantId}', '${homeBId}', 'email-draft-${draftBId}',
       'general'::"core"."EmailSourceKind", 'Sensitive Birch draft',
       'manager@example.test', 'Sensitive Birch update', 'This Birch House sensitive update also needs manager review.',
       'sensitive'::"core"."EmailSensitivity", '["family contact"]'::jsonb,
       'needs_review'::"core"."EmailDraftStatus", '${requesterUserId}', now(), now()),
      ('${auditApproveDraftId}', '${tenantId}', '${homeAId}', 'email-draft-${auditApproveDraftId}',
       'general'::"core"."EmailSourceKind", 'Audit approve draft',
       'manager@example.test', 'Audit approve', 'Audit approve body requires enough text for the draft record.',
       'sensitive'::"core"."EmailSensitivity", '[]'::jsonb,
       'needs_review'::"core"."EmailDraftStatus", '${requesterUserId}', now(), now()),
      ('${auditRejectDraftId}', '${tenantId}', '${homeAId}', 'email-draft-${auditRejectDraftId}',
       'general'::"core"."EmailSourceKind", 'Audit reject draft',
       'manager@example.test', 'Audit reject', 'Audit reject body requires enough text for the draft record.',
       'sensitive'::"core"."EmailSensitivity", '[]'::jsonb,
       'needs_review'::"core"."EmailDraftStatus", '${requesterUserId}', now(), now());

    INSERT INTO core.approvals (
      id, tenant_id, home_id, workflow_id, subject_type, subject_id,
      title, summary, status, requested_by_user_id, signatures_required,
      required_roles, signatures, created_at, updated_at
    ) VALUES
      ('${approvalAId}', '${tenantId}', '${homeAId}', 'approval-${approvalAId}', 'email_draft', '${draftAId}',
       'Sensitive family update', 'This draft needs manager review.', 'pending'::"core"."ApprovalStatus", '${requesterUserId}',
       2, ARRAY['manager', 'safeguarding_lead'], '[]'::jsonb, now(), now()),
      ('${approvalBId}', '${tenantId}', '${homeBId}', 'approval-${approvalBId}', 'email_draft', '${draftBId}',
       'Sensitive Birch update', 'This Birch draft needs manager review.', 'pending'::"core"."ApprovalStatus", '${requesterUserId}',
       2, ARRAY['manager', 'safeguarding_lead'], '[]'::jsonb, now(), now()),
      ('${auditApproveId}', '${tenantId}', '${homeAId}', 'approval-${auditApproveId}', 'email_draft', '${auditApproveDraftId}',
       'Audit approve', 'Audit approve approval.', 'pending'::"core"."ApprovalStatus", '${requesterUserId}',
       1, ARRAY['manager'], '[]'::jsonb, now(), now()),
      ('${auditRejectId}', '${tenantId}', '${homeAId}', 'approval-${auditRejectId}', 'email_draft', '${auditRejectDraftId}',
       'Audit reject', 'Audit reject approval.', 'pending'::"core"."ApprovalStatus", '${requesterUserId}',
       1, ARRAY['manager'], '[]'::jsonb, now(), now()),
      ('${incidentApprovalId}', '${tenantId}', '${homeAId}', 'approval-${incidentApprovalId}', 'incident', '${incidentId}',
       'Safeguarding incident review', 'Safeguarding incident requires manager and DSL review.',
       'pending'::"core"."ApprovalStatus", '${requesterUserId}', 2,
       ARRAY['manager', 'safeguarding_lead'], '[]'::jsonb, now(), now());
  `);
}
