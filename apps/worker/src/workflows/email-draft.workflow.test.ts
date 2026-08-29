import { beforeEach, describe, expect, it, vi } from 'vitest';

const activityMocks = vi.hoisted(() => ({
  dispatchEmailDraftNotifications: vi.fn(),
  draftEmail: vi.fn(),
  persistEmailDraft: vi.fn(),
  resolveApprovalRequirementActivity: vi.fn(),
  validateEmailDraft: vi.fn(),
}));
const proxyActivitiesMock = vi.hoisted(() => vi.fn(() => activityMocks));
const startChildMock = vi.hoisted(() => vi.fn());

vi.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: { ABANDON: 'ABANDON' },
  defineQuery: vi.fn((name: string) => name),
  proxyActivities: proxyActivitiesMock,
  setHandler: vi.fn(),
  startChild: startChildMock,
}));

import { EmailDraftWorkflow } from './email-draft.workflow.js';

describe('EmailDraftWorkflow', () => {
  beforeEach(() => {
    for (const mock of Object.values(activityMocks)) mock.mockReset();
    startChildMock.mockReset();
    activityMocks.validateEmailDraft.mockResolvedValue({
      errors: [],
      missingMandatory: [],
      valid: true,
    });
    activityMocks.resolveApprovalRequirementActivity.mockResolvedValue({
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
    });
    activityMocks.persistEmailDraft.mockResolvedValue({
      emailDraftId: '22222222-2222-4222-8222-222222222222',
      sensitivity: 'sensitive',
      status: 'needs_review',
    });
    activityMocks.dispatchEmailDraftNotifications.mockResolvedValue({ dispatched: true });
    startChildMock.mockResolvedValue({});
  });

  it('allows the model-backed draft activity to run longer than deterministic activities', () => {
    expect(proxyActivitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ startToCloseTimeout: '5 minutes' }),
    );
    expect(proxyActivitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ startToCloseTimeout: '30 seconds' }),
    );
  });

  it('validates and persists a prepared safeguarding draft without invoking the model', async () => {
    await EmailDraftWorkflow({
      actor: { correlationId: 'corr-system', kind: 'system', userId: null },
      authorUserId: '44444444-4444-4444-8444-444444444444',
      correlationId: 'corr-system',
      emailDraftId: '22222222-2222-4222-8222-222222222222',
      homeId: '33333333-3333-4333-8333-333333333333',
      instructions: 'Prepare a safeguarding review notice.',
      preparedDraft: {
        body: 'Please review the approved safeguarding incident in the secure CareOS record.',
        sensitivity: 'sensitive',
        sensitivityReasons: ['safeguarding'],
        subject: 'Safeguarding incident review',
      },
      recipient: {
        email: 'dsl@example.com',
        name: 'Safeguarding lead',
        role: 'safeguarding_contact',
      },
      source: {
        id: '55555555-5555-4555-8555-555555555555',
        kind: 'incident',
        summary: 'Approved safeguarding incident',
      },
      tenantId: '11111111-1111-4111-8111-111111111111',
    });

    expect(activityMocks.draftEmail).not.toHaveBeenCalled();
    expect(activityMocks.validateEmailDraft).toHaveBeenCalledWith({
      formData: expect.objectContaining({
        sensitivity: 'sensitive',
        subject: 'Safeguarding incident review',
      }),
    });
    expect(activityMocks.persistEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ kind: 'system', userId: null }),
        sensitivity: 'sensitive',
        status: 'needs_review',
      }),
    );
    expect(startChildMock).toHaveBeenCalledWith(
      'ApprovalRoutingWorkflow',
      expect.objectContaining({
        args: [
          expect.objectContaining({
            requiredRoles: ['manager', 'safeguarding_lead'],
            signaturesRequired: 2,
          }),
        ],
      }),
    );
  });
});
