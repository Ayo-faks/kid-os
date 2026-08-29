import type { ApprovalActor, ApprovalSignature } from '@careos/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalsService } from './approvals.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const incidentId = '33333333-3333-4333-8333-333333333333';
const approvalId = '44444444-4444-4444-8444-444444444444';
const managerId = '55555555-5555-4555-8555-555555555555';
const secondManagerId = '66666666-6666-4666-8666-666666666666';

describe('ApprovalsService', () => {
  it('marks a pending queue item when the current user has already signed', async () => {
    const signature: ApprovalSignature = {
      decidedAt: '2026-07-10T12:00:00.000Z',
      decision: 'approved',
      role: 'manager',
      userId: managerId,
    };
    const harness = createHarness([
      [
        {
          createdAt: new Date('2026-07-10T12:00:00.000Z'),
          emailRecipientEmail: null,
          emailSensitivity: null,
          emailStatus: null,
          emailSubject: null,
          id: approvalId,
          incidentResidentId: incidentId,
          incidentResidentName: 'Jamie Connor',
          incidentStatus: 'awaiting_approval',
          incidentTemplateId: 'incident.safeguarding',
          requiredRoles: ['manager', 'safeguarding_lead'],
          requestedByUserId: secondManagerId,
          signatures: [signature],
          signaturesRequired: 2,
          status: 'pending',
          subjectId: incidentId,
          subjectType: 'incident',
          summary: 'Safeguarding review.',
          title: 'Safeguarding incident review',
        },
      ],
    ]);

    await expect(
      harness.service.listPending(context(managerId, ['manager'])),
    ).resolves.toMatchObject({
      items: [
        {
          currentUserHasSigned: true,
          missingRoles: ['safeguarding_lead'],
          signaturesRecorded: 1,
        },
      ],
    });
  });

  it('resolves the incident subject before signaling its generic approval workflow', async () => {
    const harness = createHarness([[{ id: approvalId }], [approvalRow()]]);

    await expect(
      harness.service.approveIncident(
        incidentId,
        { reason: 'Reviewed.' },
        context(managerId, ['manager']),
      ),
    ).resolves.toEqual({ accepted: true, workflowId: `approval-${approvalId}` });
    expect(harness.temporal.signalApprovalDecision).toHaveBeenCalledWith(
      approvalId,
      {
        actor: actor(managerId),
        decidedByUserId: managerId,
        decision: 'approved',
        reason: 'Reviewed.',
      },
      { homeId, tenantId },
    );
  });

  it('rejects a second manager when only safeguarding coverage remains', async () => {
    const signatures: ApprovalSignature[] = [
      {
        decidedAt: '2026-07-10T12:00:00.000Z',
        decision: 'approved',
        role: 'manager',
        userId: managerId,
      },
    ];
    const harness = createHarness([[approvalRow(signatures)]]);

    await expect(
      harness.service.approve(approvalId, {}, context(secondManagerId, ['manager'])),
    ).rejects.toThrow(/outstanding required role/i);
    expect(harness.temporal.signalApprovalDecision).not.toHaveBeenCalled();
  });

  it('does not let an ops admin substitute for an approval role', async () => {
    const opsAdminId = '77777777-7777-4777-8777-777777777777';
    const harness = createHarness([[approvalRow()]]);

    await expect(
      harness.service.approve(approvalId, {}, context(opsAdminId, ['ops_admin'])),
    ).rejects.toThrow(/outstanding required role/i);
    expect(harness.temporal.signalApprovalDecision).not.toHaveBeenCalled();
  });
});

function approvalRow(signatures: readonly ApprovalSignature[] = []) {
  return {
    requiredRoles: ['manager', 'safeguarding_lead'],
    signatures,
    status: 'pending',
  } as const;
}

function actor(userId: string): ApprovalActor {
  return { correlationId: 'corr-approval', kind: 'user', userId };
}

function context(userId: string, roles: readonly string[]) {
  return {
    actor: actor(userId),
    authorUserId: userId,
    correlationId: 'corr-approval',
    homeId,
    roles,
    tenantId,
  };
}

function createHarness(queryResults: readonly (readonly unknown[])[]) {
  const transaction = {
    $queryRaw: vi.fn(),
  };
  for (const result of queryResults) {
    transaction.$queryRaw.mockResolvedValueOnce(result);
  }
  const prisma: unknown = {
    withTenantContext: vi.fn(
      (_context: unknown, callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
  const temporal = {
    signalApprovalDecision: vi.fn().mockResolvedValue(undefined),
  };
  const service = new ApprovalsService(
    prisma as ConstructorParameters<typeof ApprovalsService>[0],
    temporal,
  );
  return { service, temporal };
}
