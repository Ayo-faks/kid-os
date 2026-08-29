import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const activityMocks = vi.hoisted(() => ({
  applyApprovalDecision: vi.fn(),
  createApprovalRequest: vi.fn(),
}));
const patchedMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('@temporalio/workflow', () => ({
  condition: vi.fn((predicate: () => boolean) => {
    if (!predicate()) throw new Error('condition reached without a queued decision');
    return Promise.resolve();
  }),
  defineQuery: vi.fn((name: string) => name),
  defineSignal: vi.fn((name: string) => name),
  patched: patchedMock,
  proxyActivities: vi.fn(() => activityMocks),
  setHandler: vi.fn((definition: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(definition, handler);
  }),
}));

import { ApprovalRoutingWorkflow } from './approval-routing.workflow.js';

const managerId = '55555555-5555-4555-8555-555555555555';
const safeguardingId = '66666666-6666-4666-8666-666666666666';
const input = {
  actor: {
    correlationId: 'corr-approval-workflow',
    kind: 'user' as const,
    userId: '44444444-4444-4444-8444-444444444444',
  },
  approvalId: '33333333-3333-4333-8333-333333333333',
  homeId: '22222222-2222-4222-8222-222222222222',
  requestedByUserId: '44444444-4444-4444-8444-444444444444',
  requiredRoles: ['manager', 'safeguarding_lead'] as const,
  signaturesRequired: 2 as const,
  subjectId: '77777777-7777-4777-8777-777777777777',
  subjectType: 'incident' as const,
  summary: 'Safeguarding incident requiring dual sign-off.',
  tenantId: '11111111-1111-4111-8111-111111111111',
  title: 'Safeguarding incident',
};

describe('ApprovalRoutingWorkflow', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    patchedMock.mockReturnValue(true);
  });

  it('drains queued role decisions until the dual-sign-off requirement is terminal', async () => {
    const managerSignature = {
      decidedAt: '2026-07-10T12:00:00.000Z',
      decision: 'approved' as const,
      role: 'manager' as const,
      userId: managerId,
    };
    activityMocks.createApprovalRequest.mockImplementationOnce(() => {
      const decide = handlers.get('decide');
      decide?.({
        actor: { correlationId: 'corr-manager', kind: 'user', userId: managerId },
        decidedByUserId: managerId,
        decision: 'approved',
      });
      decide?.({
        actor: { correlationId: 'corr-dsl', kind: 'user', userId: safeguardingId },
        decidedByUserId: safeguardingId,
        decision: 'approved',
      });
      return Promise.resolve({
        approvalId: input.approvalId,
        requiredRoles: [...input.requiredRoles],
        signatures: [],
        signaturesRequired: 2,
        status: 'pending',
      });
    });
    activityMocks.applyApprovalDecision
      .mockResolvedValueOnce({
        approvalId: input.approvalId,
        requiredRoles: [...input.requiredRoles],
        signatures: [managerSignature],
        signaturesRequired: 2,
        status: 'pending',
        subjectId: input.subjectId,
        subjectType: 'incident',
      })
      .mockResolvedValueOnce({
        approvalId: input.approvalId,
        requiredRoles: [...input.requiredRoles],
        signatures: [
          managerSignature,
          {
            decidedAt: '2026-07-10T12:05:00.000Z',
            decision: 'approved',
            role: 'safeguarding_lead',
            userId: safeguardingId,
          },
        ],
        signaturesRequired: 2,
        status: 'approved',
        subjectId: input.subjectId,
        subjectType: 'incident',
      });

    const result = await ApprovalRoutingWorkflow(input);

    expect(activityMocks.applyApprovalDecision).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
      status: 'approved',
    });
    expect(result.signatures).toHaveLength(2);
    const query = handlers.get('getState');
    expect(query?.()).toEqual(result);
  });

  it('continues draining after a duplicate decision is an idempotent no-op', async () => {
    const managerSignature = {
      decidedAt: '2026-07-10T12:00:00.000Z',
      decision: 'approved' as const,
      role: 'manager' as const,
      userId: managerId,
    };
    activityMocks.createApprovalRequest.mockImplementationOnce(() => {
      const decide = handlers.get('decide');
      const managerDecision = {
        actor: { correlationId: 'corr-manager', kind: 'user', userId: managerId },
        decidedByUserId: managerId,
        decision: 'approved',
      };
      decide?.(managerDecision);
      decide?.(managerDecision);
      decide?.({
        actor: { correlationId: 'corr-dsl', kind: 'user', userId: safeguardingId },
        decidedByUserId: safeguardingId,
        decision: 'approved',
      });
      return Promise.resolve({
        approvalId: input.approvalId,
        requiredRoles: [...input.requiredRoles],
        signatures: [],
        signaturesRequired: 2,
        status: 'pending',
      });
    });
    activityMocks.applyApprovalDecision
      .mockResolvedValueOnce({
        approvalId: input.approvalId,
        requiredRoles: [...input.requiredRoles],
        signatures: [managerSignature],
        signaturesRequired: 2,
        status: 'pending',
        subjectId: input.subjectId,
        subjectType: 'incident',
      })
      .mockResolvedValueOnce({
        approvalId: input.approvalId,
        requiredRoles: [...input.requiredRoles],
        signatures: [managerSignature],
        signaturesRequired: 2,
        status: 'pending',
        subjectId: input.subjectId,
        subjectType: 'incident',
      })
      .mockResolvedValueOnce({
        approvalId: input.approvalId,
        requiredRoles: [...input.requiredRoles],
        signatures: [
          managerSignature,
          {
            decidedAt: '2026-07-10T12:05:00.000Z',
            decision: 'approved',
            role: 'safeguarding_lead',
            userId: safeguardingId,
          },
        ],
        signaturesRequired: 2,
        status: 'approved',
        subjectId: input.subjectId,
        subjectType: 'incident',
      });

    await expect(ApprovalRoutingWorkflow(input)).resolves.toMatchObject({ status: 'approved' });
    expect(activityMocks.applyApprovalDecision).toHaveBeenCalledTimes(3);
  });

  it('preserves the legacy single-decision completion path when the patch is absent', async () => {
    patchedMock.mockReturnValue(false);
    activityMocks.createApprovalRequest.mockImplementationOnce(() => {
      handlers.get('decide')?.({
        actor: { correlationId: 'corr-manager', kind: 'user', userId: managerId },
        decidedByUserId: managerId,
        decision: 'approved',
      });
      return Promise.resolve({ approvalId: input.approvalId, status: 'pending' });
    });
    activityMocks.applyApprovalDecision.mockResolvedValueOnce({
      approvalId: input.approvalId,
      requiredRoles: ['manager'],
      signatures: [],
      signaturesRequired: 1,
      status: 'approved',
      subjectId: input.subjectId,
      subjectType: 'incident',
    });

    await expect(ApprovalRoutingWorkflow(input)).resolves.toMatchObject({ status: 'approved' });
    expect(activityMocks.applyApprovalDecision).toHaveBeenCalledTimes(1);
  });
});
