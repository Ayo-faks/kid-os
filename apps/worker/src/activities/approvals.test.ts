import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withTenantContext: withTenantContextMock,
}));

import { applyApprovalDecision, createApprovalRequest } from './approvals.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const approvalId = '33333333-3333-4333-8333-333333333333';
const emailDraftId = '44444444-4444-4444-8444-444444444444';
const requesterUserId = '55555555-5555-4555-8555-555555555555';
const deciderUserId = '66666666-6666-4666-8666-666666666666';
const safeguardingUserId = '77777777-7777-4777-8777-777777777777';
const incidentId = '88888888-8888-4888-8888-888888888888';

const actor = {
  correlationId: 'corr-approval-test',
  kind: 'user' as const,
  userId: requesterUserId,
};

describe('approval activities', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns an existing approval request idempotently', async () => {
    const query = mockTenantClient([
      { rows: [approvalRow()], rowCount: 1 },
      { rows: [ownerRow()], rowCount: 1 },
    ]);

    await expect(createApprovalRequest(createApprovalInput())).resolves.toEqual(
      expect.objectContaining({
        approvalId,
        requiredRoles: ['manager'],
        signatures: [],
        signaturesRequired: 1,
        status: 'pending',
      }),
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('INSERT INTO core.workflow_instances');
  });

  it('creates a pending approval request when none exists', async () => {
    const query = mockTenantClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [approvalRow()], rowCount: 1 },
      { rows: [ownerRow()], rowCount: 1 },
    ]);

    await expect(createApprovalRequest(createApprovalInput())).resolves.toEqual(
      expect.objectContaining({ approvalId, signaturesRequired: 1, status: 'pending' }),
    );
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[1]?.[0]).toContain('INSERT INTO core.approvals');
  });

  it('approves an email-draft approval and queues an outbox stub', async () => {
    const query = mockTenantClient([
      {
        rows: [approvalRow()],
        rowCount: 1,
      },
      { rows: [{ roles: ['manager'] }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ status: 'approved' }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    const result = await applyApprovalDecision({
      actor: { ...actor, userId: deciderUserId },
      approvalId,
      decidedByUserId: deciderUserId,
      decision: 'approved',
      homeId,
      reason: 'Looks ready.',
      tenantId,
    });

    expect(result).toMatchObject({
      approvalId,
      emailDraftStatus: 'approved',
      status: 'approved',
      subjectId: emailDraftId,
      subjectType: 'email_draft',
    });
    expect(result.outboxId).toMatch(/^[0-9a-f-]{36}$/);
    expect(query).toHaveBeenCalledTimes(6);
    expect(query.mock.calls[2]?.[1]).toEqual([
      'approved',
      expect.stringContaining(deciderUserId),
      deciderUserId,
      'Looks ready.',
      approvalId,
    ]);
    expect(query.mock.calls[4]?.[0]).toContain('novu.email_draft.approved');
  });

  it('rejects an email-draft approval without queueing send work', async () => {
    const query = mockTenantClient([
      {
        rows: [approvalRow()],
        rowCount: 1,
      },
      { rows: [{ roles: ['manager'] }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ status: 'rejected' }], rowCount: 1 },
    ]);

    await expect(
      applyApprovalDecision({
        actor: { ...actor, userId: deciderUserId },
        approvalId,
        decidedByUserId: deciderUserId,
        decision: 'rejected',
        homeId,
        reason: 'Needs a rewrite.',
        tenantId,
      }),
    ).resolves.toMatchObject({
      approvalId,
      emailDraftStatus: 'rejected',
      status: 'rejected',
      subjectId: emailDraftId,
      subjectType: 'email_draft',
    });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[3]?.[0]).toContain('UPDATE core.email_drafts');
  });

  it('does not mutate an approval that already has a terminal decision', async () => {
    const query = mockTenantClient([
      {
        rows: [approvalRow({ status: 'approved' })],
        rowCount: 1,
      },
      { rows: [{ status: 'approved' }], rowCount: 1 },
    ]);

    await expect(
      applyApprovalDecision({
        actor: { ...actor, userId: deciderUserId },
        approvalId,
        decidedByUserId: deciderUserId,
        decision: 'approved',
        homeId,
        tenantId,
      }),
    ).resolves.toMatchObject({
      approvalId,
      emailDraftStatus: 'approved',
      status: 'approved',
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps dual sign-off pending after manager and approves after a distinct safeguarding lead', async () => {
    const managerSignature = {
      decidedAt: '2026-07-10T12:00:00.000Z',
      decision: 'approved',
      role: 'manager',
      userId: deciderUserId,
    };
    const firstQuery = mockTenantClient([
      {
        rows: [
          approvalRow({ required_roles: ['manager', 'safeguarding_lead'], signatures_required: 2 }),
        ],
        rowCount: 1,
      },
      { rows: [{ roles: ['manager'] }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    await expect(
      applyApprovalDecision({
        actor: { ...actor, userId: deciderUserId },
        approvalId,
        decidedByUserId: deciderUserId,
        decision: 'approved',
        homeId,
        tenantId,
      }),
    ).resolves.toMatchObject({ status: 'pending', signaturesRequired: 2 });
    expect(firstQuery).toHaveBeenCalledTimes(3);

    const secondQuery = mockTenantClient([
      {
        rows: [
          approvalRow({
            required_roles: ['manager', 'safeguarding_lead'],
            signatures: [managerSignature],
            signatures_required: 2,
          }),
        ],
        rowCount: 1,
      },
      { rows: [{ roles: ['safeguarding_lead'] }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ status: 'approved' }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const result = await applyApprovalDecision({
      actor: { ...actor, userId: safeguardingUserId },
      approvalId,
      decidedByUserId: safeguardingUserId,
      decision: 'approved',
      homeId,
      tenantId,
    });
    expect(result.status).toBe('approved');
    expect(result.signatures).toEqual([
      managerSignature,
      expect.objectContaining({ role: 'safeguarding_lead', userId: safeguardingUserId }),
    ]);
    expect(secondQuery).toHaveBeenCalledTimes(6);
  });

  it('deduplicates the same user and permits an ops-admin veto', async () => {
    const existingSignature = {
      decidedAt: '2026-07-10T12:00:00.000Z',
      decision: 'approved',
      role: 'manager',
      userId: deciderUserId,
    };
    const duplicateQuery = mockTenantClient([
      {
        rows: [
          approvalRow({
            required_roles: ['manager', 'safeguarding_lead'],
            signatures: [existingSignature],
            signatures_required: 2,
          }),
        ],
        rowCount: 1,
      },
    ]);
    await expect(
      applyApprovalDecision({
        actor: { ...actor, userId: deciderUserId },
        approvalId,
        decidedByUserId: deciderUserId,
        decision: 'approved',
        homeId,
        tenantId,
      }),
    ).resolves.toMatchObject({ signatures: [existingSignature], status: 'pending' });
    expect(duplicateQuery).toHaveBeenCalledTimes(1);

    const opsUserId = '99999999-9999-4999-8999-999999999999';
    const vetoQuery = mockTenantClient([
      {
        rows: [
          approvalRow({
            required_roles: ['manager', 'safeguarding_lead'],
            signatures_required: 2,
          }),
        ],
        rowCount: 1,
      },
      { rows: [{ roles: ['ops_admin'] }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [{ status: 'rejected' }], rowCount: 1 },
    ]);
    await expect(
      applyApprovalDecision({
        actor: { ...actor, userId: opsUserId },
        approvalId,
        decidedByUserId: opsUserId,
        decision: 'rejected',
        homeId,
        reason: 'Safeguarding veto.',
        tenantId,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(vetoQuery).toHaveBeenCalledTimes(5);
  });

  it('applies a terminal incident decision without duplicating the workflow timeline event', async () => {
    const query = mockTenantClient([
      { rows: [approvalRow({ subject_id: incidentId, subject_type: 'incident' })], rowCount: 1 },
      { rows: [{ roles: ['manager'] }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    await expect(
      applyApprovalDecision({
        actor: { ...actor, userId: deciderUserId },
        approvalId,
        decidedByUserId: deciderUserId,
        decision: 'approved',
        homeId,
        tenantId,
      }),
    ).resolves.toMatchObject({
      incidentStatus: 'approved',
      status: 'approved',
      subjectId: incidentId,
      subjectType: 'incident',
    });
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE core.incidents'))).toBe(
      false,
    );
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO core.timeline_entries')),
    ).toBe(false);
  });
});

function createApprovalInput() {
  return {
    actor,
    approvalId,
    homeId,
    requestedByUserId: requesterUserId,
    orchestrationName: 'ApprovalRoutingOrchestratorV1',
    orchestrationVersion: '1.0.0',
    requiredRoles: ['manager'] as const,
    runtime: 'durable' as const,
    signaturesRequired: 1 as const,
    subjectId: emailDraftId,
    subjectType: 'email_draft' as const,
    summary: 'Sensitive email draft for manager review.',
    tenantId,
    title: 'Sensitive update',
    workflowId: `approval-${approvalId}`,
  };
}

function ownerRow() {
  return { instance_id: `approval-${approvalId}`, runtime: 'durable' as const };
}

function approvalRow(
  overrides: Partial<{
    readonly id: string;
    readonly required_roles: ('manager' | 'safeguarding_lead')[];
    readonly signatures: readonly unknown[];
    readonly signatures_required: 1 | 2;
    readonly status: 'pending' | 'approved' | 'rejected';
    readonly subject_id: string;
    readonly subject_type: 'email_draft' | 'incident';
  }> = {},
) {
  return {
    id: approvalId,
    required_roles: ['manager'] as ('manager' | 'safeguarding_lead')[],
    signatures: [] as readonly unknown[],
    signatures_required: 1 as 1 | 2,
    status: 'pending' as const,
    subject_id: emailDraftId,
    subject_type: 'email_draft' as const,
    ...overrides,
  };
}

function mockTenantClient(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>();
  for (const result of results) {
    query.mockResolvedValueOnce(result);
  }

  withTenantContextMock.mockImplementation(
    (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) =>
      callback({ query } as unknown as PoolClient),
  );
  return query;
}
