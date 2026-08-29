import { afterEach, describe, expect, it, vi } from 'vitest';

const { queryMock, withTenantContextMock } = vi.hoisted(() => ({
  queryMock: vi.fn(
    (_sql: string, _parameters?: readonly unknown[]): Promise<{ rows: unknown[] }> =>
      Promise.resolve({ rows: [] }),
  ),
  withTenantContextMock: vi.fn(
    (_context: unknown, callback: (client: { query: typeof queryMock }) => Promise<unknown>) =>
      callback({ query: queryMock }),
  ),
}));

vi.mock('../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import {
  draftIncidentFromText,
  persistIncidentVersion,
  routeForApproval,
  resolveIncidentApprovalRequirement,
  validateAgainstSchema,
  writeAuditEvent,
} from './incidents.js';

const TEMPLATE = { templateId: 'incident.behavioural', version: 'v1' } as const;
const originalFetch = globalThis.fetch;

afterEach(() => {
  queryMock.mockClear();
  withTenantContextMock.mockClear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('routeForApproval', () => {
  it('queues one idempotent internal notification for immediate risk', async () => {
    await routeForApproval({
      actor: {
        correlationId: 'corr-immediate-risk',
        kind: 'user',
        userId: '44444444-4444-4444-8444-444444444444',
      },
      homeId: '22222222-2222-4222-8222-222222222222',
      immediateRisk: true,
      incidentId: '11111111-1111-4111-8111-111111111111',
      residentId: '55555555-5555-4555-8555-555555555555',
      safeguarding: true,
      tenantId: '33333333-3333-4333-8333-333333333333',
      version: 2,
    });

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(String(queryMock.mock.calls[1]?.[0])).toContain('novu.incident.immediate_risk');
    expect(queryMock.mock.calls[1]?.[1]?.[3]).toBe(
      JSON.stringify({
        incidentId: '11111111-1111-4111-8111-111111111111',
        residentId: '55555555-5555-4555-8555-555555555555',
        safeguarding: true,
        version: 2,
      }),
    );
  });
});

describe('writeAuditEvent', () => {
  it('uses the current audit.events action/subject/metadata columns', async () => {
    await writeAuditEvent({
      actor: {
        agentRunId: 'agent-run-1',
        correlationId: 'corr-audit',
        kind: 'agent',
        promptHash: 'prompt-hash',
        userId: '44444444-4444-4444-8444-444444444444',
      },
      eventType: 'incident.approval_routed',
      homeId: '22222222-2222-4222-8222-222222222222',
      incidentId: '11111111-1111-4111-8111-111111111111',
      payload: { status: 'awaiting_approval' },
      residentId: '55555555-5555-4555-8555-555555555555',
      tenantId: '33333333-3333-4333-8333-333333333333',
    });

    expect(withTenantContextMock).toHaveBeenCalledTimes(1);
    const sql = String(queryMock.mock.calls[0]?.[0]);
    expect(sql).toContain('action, subject_type, subject_id');
    expect(sql).toContain('correlation_id, metadata, occurred_at');
    expect(sql).not.toContain('event_type');
    expect(sql).not.toContain('target_kind');
    expect(sql).not.toContain('target_id');
    expect(sql).not.toContain('payload');
    expect(queryMock.mock.calls[0]?.[1]).toEqual([
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
      'incident.approval_routed',
      '11111111-1111-4111-8111-111111111111',
      'agent',
      '44444444-4444-4444-8444-444444444444',
      'agent-run-1',
      'prompt-hash',
      'corr-audit',
      JSON.stringify({ status: 'awaiting_approval' }),
    ]);
  });
});

describe('persistIncidentVersion', () => {
  it('records terminal approver metadata in the same update as the approved version', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'template-id' }] });

    await persistIncidentVersion({
      actor: {
        correlationId: 'corr-approved',
        kind: 'user',
        userId: '44444444-4444-4444-8444-444444444444',
      },
      authorUserId: '55555555-5555-4555-8555-555555555555',
      formData: { summary: 'Approved incident.' },
      formTemplate: TEMPLATE,
      homeId: '22222222-2222-4222-8222-222222222222',
      incidentId: '11111111-1111-4111-8111-111111111111',
      missingMandatory: [],
      residentId: '66666666-6666-4666-8666-666666666666',
      status: 'approved',
      tenantId: '33333333-3333-4333-8333-333333333333',
      validationErrors: [],
      version: 3,
      workflowId: 'incident-11111111-1111-4111-8111-111111111111',
    });

    expect(String(queryMock.mock.calls[1]?.[0])).toContain('approved_by_user_id');
    expect(queryMock.mock.calls[1]?.[1]).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'approved',
      3,
      '44444444-4444-4444-8444-444444444444',
    ]);
  });
});

describe('resolveIncidentApprovalRequirement', () => {
  it('routes routine incidents to one manager signature', async () => {
    await expect(
      resolveIncidentApprovalRequirement({
        formData: { safeguardingConcern: false },
        formTemplate: TEMPLATE,
      }),
    ).resolves.toEqual({
      immediateRisk: false,
      level: 'confirm',
      requiredRoles: ['manager'],
      safeguarding: false,
      signaturesRequired: 1,
    });
  });

  it.each([
    [
      'template',
      { formData: {}, formTemplate: { templateId: 'incident.safeguarding', version: 'v1' } },
    ],
    ['staff concern', { formData: { safeguardingConcern: true }, formTemplate: TEMPLATE }],
    ['immediate risk', { formData: { isChildAtImmediateRisk: true }, formTemplate: TEMPLATE }],
    ['DSL report', { formData: { reportedToDsl: true }, formTemplate: TEMPLATE }],
    ['category', { formData: { category: 'neglect' }, formTemplate: TEMPLATE }],
  ])('routes explicit safeguarding signal: %s', async (_label, input) => {
    await expect(resolveIncidentApprovalRequirement(input)).resolves.toMatchObject({
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      safeguarding: true,
      signaturesRequired: 2,
    });
  });

  it('ignores an AI-only advisory flag', async () => {
    await expect(
      resolveIncidentApprovalRequirement({
        formData: { aiSafeguardingSuggestion: true },
        formTemplate: TEMPLATE,
      }),
    ).resolves.toMatchObject({ safeguarding: false, signaturesRequired: 1 });
  });
});

describe('draftIncidentFromText', () => {
  it('calls the Hermes draft_incident_from_text tool', async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      expect(input).toEqual(new URL('http://hermes.local:8080/mcp'));
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        'content-type': 'application/json',
        'x-careos-correlation-id': 'corr-1',
      });

      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        readonly method?: string;
        readonly params?: {
          readonly arguments?: Record<string, unknown>;
          readonly name?: string;
        };
      };
      expect(body.method).toBe('tools/call');
      expect(body.params?.name).toBe('draft_incident_from_text');
      expect(body.params?.arguments).toEqual({
        correlation_id: 'corr-1',
        free_text: 'Jamie became distressed in the lounge.',
        resident_id: '11111111-1111-4111-8111-111111111111',
        template_id: 'incident.behavioural',
      });

      return Promise.resolve(
        Response.json({
          id: body.method,
          jsonrpc: '2.0',
          result: {
            content: [
              {
                text: JSON.stringify({
                  confidence: 0.82,
                  form_data: { summary: 'Jamie became distressed in the lounge.' },
                  missing_mandatory: ['occurredAt'],
                }),
                type: 'text',
              },
            ],
            isError: false,
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('HERMES_URL', 'http://hermes.local:8080');

    const result = await draftIncidentFromText({
      correlationId: 'corr-1',
      formTemplate: TEMPLATE,
      homeId: '22222222-2222-4222-8222-222222222222',
      narrative: 'Jamie became distressed in the lounge.',
      residentId: '11111111-1111-4111-8111-111111111111',
      tenantId: '33333333-3333-4333-8333-333333333333',
    });

    expect(result).toEqual({
      confidence: 0.82,
      formData: { summary: 'Jamie became distressed in the lounge.' },
      missingMandatory: ['occurredAt'],
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});

describe('validateAgainstSchema', () => {
  it('flags missing mandatory fields without throwing', async () => {
    const result = await validateAgainstSchema({ formData: {}, formTemplate: TEMPLATE });
    expect(result.valid).toBe(false);
    expect(result.missingMandatory.length).toBeGreaterThan(0);
  });

  it('detects schema type mismatches with JSON pointers', async () => {
    const result = await validateAgainstSchema({
      formData: {
        behaviourType: 'verbal_aggression',
        location: 123,
        occurredAt: '2026-01-01T10:00:00Z',
        outcomeForResident: 'calmed down',
        residentId: '11111111-1111-4111-8111-111111111111',
        responseTaken: 'gave space',
        summary: 'verbal escalation',
        triggers: ['transition'],
      },
      formTemplate: TEMPLATE,
    });
    expect(result.errors.some((e: { path: string }) => e.path === '/location')).toBe(true);
  });

  it('accepts a fully populated incident as valid', async () => {
    const result = await validateAgainstSchema({
      formData: {
        behaviourType: 'verbal_aggression',
        location: 'lounge',
        occurredAt: '2026-01-01T10:00:00Z',
        outcomeForResident: 'calmed down',
        residentId: '11111111-1111-4111-8111-111111111111',
        responseTaken: 'gave space',
        summary: 'verbal escalation',
        triggers: ['transition'],
      },
      formTemplate: TEMPLATE,
    });
    expect(result.valid).toBe(true);
    expect(result.missingMandatory).toEqual([]);
  });

  it('enforces safeguarding conditional requirements', async () => {
    const result = await validateAgainstSchema({
      formData: {
        category: 'neglect',
        discoveredAt: '2026-07-10T10:10:00Z',
        immediateActionsTaken: 'The child was moved to a safe space.',
        isChildAtImmediateRisk: false,
        occurredAt: '2026-07-10T10:00:00Z',
        reportedToDsl: true,
        residentId: '11111111-1111-4111-8111-111111111111',
        summary: 'A factual safeguarding concern requiring designated lead review.',
      },
      formTemplate: { templateId: 'incident.safeguarding', version: 'v1' },
    });

    expect(result.valid).toBe(false);
    expect(result.missingMandatory).toContain('reportedToDslAt');
    expect(result.errors.map((error) => error.path)).toContain('/reportedToDslAt');
  });
});
