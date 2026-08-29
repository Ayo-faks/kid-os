import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const activityMocks = vi.hoisted(() => ({
  applyApprovalDecision: vi.fn(),
  createApprovalRequest: vi.fn(),
}));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/approvals.js', () => activityMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import {
  applyApprovalDecisionCommandActivity,
  createApprovalRequestFromReferenceActivity,
} from './approval-routing.activities.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const approvalId = '33333333-3333-4333-8333-333333333333';
const requesterId = '44444444-4444-4444-8444-444444444444';
const managerId = '55555555-5555-4555-8555-555555555555';
const subjectId = '77777777-7777-4777-8777-777777777777';
const commandId = '88888888-8888-4888-8888-888888888888';
const actor = { correlationId: 'corr-approval', kind: 'user' as const, userId: requesterId };

const context = new ActivityContext('approval-test', 1);

describe('Durable approval activities', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads subject prose inside the worker and registers Durable ownership', async () => {
    const query = tenantQuery([
      { rows: [], rowCount: 0 },
      { rows: [{ summary: 'Sensitive body', title: 'Sensitive subject' }], rowCount: 1 },
    ]);
    activityMocks.createApprovalRequest.mockResolvedValue({
      approvalId,
      requiredRoles: ['manager', 'safeguarding_lead'],
      signatures: [],
      signaturesRequired: 2,
      status: 'pending',
    });

    const result = await createApprovalRequestFromReferenceActivity(context, {
      actor,
      approvalId,
      homeId,
      requestedByUserId: requesterId,
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
      subjectId,
      subjectType: 'email_draft',
      tenantId,
      workflowId: `approval-${approvalId}`,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(activityMocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestrationName: 'ApprovalRoutingOrchestratorV1',
        orchestrationVersion: '1.0.0',
        runtime: 'durable',
        summary: 'Sensitive body',
        title: 'Sensitive subject',
      }),
    );
    expect(result).toEqual({
      approvalId,
      requiredRoles: ['manager', 'safeguarding_lead'],
      signatures: [],
      signaturesRequired: 2,
      status: 'pending',
      subjectId,
      subjectType: 'email_draft',
    });
    expect(JSON.stringify(result)).not.toContain('Sensitive');
  });

  it('loads the current safeguarding incident summary for the approval queue', async () => {
    const query = tenantQuery([
      { rows: [], rowCount: 0 },
      {
        rows: [
          {
            summary: 'Jamie disclosed a safeguarding concern.',
            title: 'Safeguarding incident review',
          },
        ],
        rowCount: 1,
      },
    ]);
    activityMocks.createApprovalRequest.mockResolvedValue({
      approvalId,
      requiredRoles: ['manager', 'safeguarding_lead'],
      signatures: [],
      signaturesRequired: 2,
      status: 'pending',
    });

    await createApprovalRequestFromReferenceActivity(context, {
      actor,
      approvalId,
      homeId,
      requestedByUserId: requesterId,
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
      subjectId,
      subjectType: 'incident',
      tenantId,
      workflowId: `approval-${approvalId}`,
    });

    expect(String(query.mock.calls[1]?.[0])).toContain("v.form_data ->> 'summary'");
    expect(String(query.mock.calls[1]?.[0])).toContain("'safeguarding_lead' = ANY($2::text[])");
    expect(query.mock.calls[1]?.[1]).toEqual([subjectId, ['manager', 'safeguarding_lead']]);
    expect(activityMocks.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Jamie disclosed a safeguarding concern.',
        title: 'Safeguarding incident review',
      }),
    );
  });

  it('loads an opaque command, applies it idempotently, and marks terminal ownership complete', async () => {
    const query = tenantQuery([
      {
        rows: [
          {
            payload: {
              actor: { ...actor, userId: managerId },
              decidedByUserId: managerId,
              decision: 'approved',
              reason: 'Reviewed in detail.',
            },
            status: 'pending',
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    activityMocks.applyApprovalDecision.mockResolvedValue({
      approvalId,
      incidentStatus: 'approved',
      requiredRoles: ['manager'],
      signatures: [
        {
          decidedAt: '2026-07-18T10:00:00.000Z',
          decision: 'approved',
          reason: 'Reviewed in detail.',
          role: 'manager',
          userId: managerId,
        },
      ],
      signaturesRequired: 1,
      status: 'approved',
      subjectId,
      subjectType: 'incident',
    });

    const result = await applyApprovalDecisionCommandActivity(context, {
      approvalId,
      commandId,
      homeId,
      tenantId,
    });

    expect(activityMocks.applyApprovalDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId,
        decidedByUserId: managerId,
        decision: 'approved',
        reason: 'Reviewed in detail.',
      }),
    );
    expect(query.mock.calls[1]?.[0]).toContain('WorkflowCommandStatus');
    expect(query.mock.calls[2]?.[0]).toContain("status = 'applied'");
    expect(query.mock.calls[3]?.[0]).toContain("status = 'completed'");
    expect(result.signatures).toEqual([
      { decision: 'approved', role: 'manager', userId: managerId },
    ]);
    expect(JSON.stringify(result)).not.toContain('Reviewed in detail');
    expect(JSON.stringify(result)).not.toContain('decidedAt');
  });

  it('marks a failed command before preserving the activity error for retry', async () => {
    const query = tenantQuery([
      {
        rows: [
          {
            payload: {
              actor: { ...actor, userId: managerId },
              decidedByUserId: managerId,
              decision: 'rejected',
            },
            status: 'pending',
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const failure = new Error('database lock timeout');
    activityMocks.applyApprovalDecision.mockRejectedValue(failure);

    await expect(
      applyApprovalDecisionCommandActivity(context, { approvalId, commandId, homeId, tenantId }),
    ).rejects.toBe(failure);
    expect(query.mock.calls[2]?.[1]).toEqual([commandId, 'failed', 'database lock timeout']);
  });
});

function tenantQuery(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  withTenantContextMock.mockImplementation(
    (_tenantContext: unknown, callback: (client: { query: typeof query }) => Promise<unknown>) =>
      callback({ query }),
  );
  return query;
}
