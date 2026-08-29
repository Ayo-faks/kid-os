import { beforeEach, describe, expect, it, vi } from 'vitest';

const activityMocks = vi.hoisted(() => ({
  dispatchEmailDraftNotifications: vi.fn(),
  dispatchHandoverNotifications: vi.fn(),
  draftEmail: vi.fn(),
  persistEmailDraft: vi.fn(),
  persistHandover: vi.fn(),
  summarizeHandover: vi.fn(),
  validateEmailDraft: vi.fn(),
  validateHandover: vi.fn(),
  resolveApprovalRequirementActivity: vi.fn(),
}));

const startChild = vi.hoisted(() => vi.fn());

vi.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: { ABANDON: 'ABANDON' },
  defineQuery: vi.fn((name: string) => name),
  proxyActivities: vi.fn(() => activityMocks),
  setHandler: vi.fn(),
  startChild,
}));

import { EmailDraftWorkflow } from './email-draft.workflow.js';
import { HandoverWorkflow } from './handover.workflow.js';

const validationErrors = [{ message: 'must match format "email"', path: '/recipient/email' }];

describe('schema-gated model workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not persist or notify when a Hermes handover fails full schema validation', async () => {
    activityMocks.summarizeHandover.mockResolvedValueOnce({
      confidence: 0.8,
      formData: {
        endedAt: 'not-a-date',
        narrative: 'A sufficiently long handover narrative.',
        shiftId: '33333333-3333-4333-8333-333333333333',
      },
      missingMandatory: [],
      promptHash: 'prompt-hash',
      summary: 'Summary',
    });
    activityMocks.validateHandover.mockResolvedValueOnce({
      errors: [{ message: 'must match format "date-time"', path: '/endedAt' }],
      missingMandatory: [],
      valid: false,
    });

    await expect(
      HandoverWorkflow({
        authorUserId: '44444444-4444-4444-8444-444444444444',
        correlationId: 'corr-handover-invalid',
        freeText: 'A sufficiently long handover narrative.',
        handoverId: '55555555-5555-4555-8555-555555555555',
        homeId: '22222222-2222-4222-8222-222222222222',
        shiftId: '33333333-3333-4333-8333-333333333333',
        tenantId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toThrow(/failed validation.*\/endedAt/i);

    expect(activityMocks.persistHandover).not.toHaveBeenCalled();
    expect(activityMocks.dispatchHandoverNotifications).not.toHaveBeenCalled();
  });

  it('does not persist, notify, or start approval when a Hermes email fails validation', async () => {
    activityMocks.draftEmail.mockResolvedValueOnce({
      body: 'This body is long enough to pass its length constraint.',
      confidence: 0.8,
      formData: {
        body: 'This body is long enough to pass its length constraint.',
        recipient: { email: 'not-an-email' },
        sensitivity: 'sensitive',
        subject: 'Sensitive update',
      },
      missingMandatory: [],
      promptHash: 'prompt-hash',
      refused: false,
      sensitivity: 'sensitive',
      sensitivityReasons: ['safeguarding content'],
      subject: 'Sensitive update',
    });
    activityMocks.validateEmailDraft.mockResolvedValueOnce({
      errors: validationErrors,
      missingMandatory: [],
      valid: false,
    });

    await expect(
      EmailDraftWorkflow({
        authorUserId: '44444444-4444-4444-8444-444444444444',
        correlationId: 'corr-email-invalid',
        emailDraftId: '55555555-5555-4555-8555-555555555555',
        homeId: '22222222-2222-4222-8222-222222222222',
        instructions: 'Draft a sensitive update for manager review.',
        recipient: { email: 'manager@example.test' },
        source: { kind: 'general', summary: 'Sensitive operational update.' },
        tenantId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toThrow(/failed validation.*\/recipient\/email/i);

    expect(activityMocks.persistEmailDraft).not.toHaveBeenCalled();
    expect(activityMocks.dispatchEmailDraftNotifications).not.toHaveBeenCalled();
    expect(startChild).not.toHaveBeenCalled();
  });

  it('starts valid email approvals on the dedicated approvals queue', async () => {
    activityMocks.draftEmail.mockResolvedValueOnce({
      body: 'This sensitive update requires distinct human review before any handling.',
      confidence: 0.9,
      formData: {
        body: 'This sensitive update requires distinct human review before any handling.',
        recipient: { email: 'manager@example.test' },
        sensitivity: 'sensitive',
        subject: 'Sensitive update',
      },
      missingMandatory: [],
      promptHash: 'prompt-hash',
      refused: false,
      sensitivity: 'sensitive',
      sensitivityReasons: ['safeguarding content'],
      subject: 'Sensitive update',
    });
    activityMocks.validateEmailDraft.mockResolvedValueOnce({
      errors: [],
      missingMandatory: [],
      valid: true,
    });
    activityMocks.resolveApprovalRequirementActivity.mockResolvedValueOnce({
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
    });
    activityMocks.persistEmailDraft.mockResolvedValueOnce({ status: 'needs_review' });
    activityMocks.dispatchEmailDraftNotifications.mockResolvedValueOnce(undefined);

    await EmailDraftWorkflow({
      approvalTaskQueue: 'careos.approvals.custom',
      authorUserId: '44444444-4444-4444-8444-444444444444',
      correlationId: 'corr-email-valid',
      emailDraftId: '55555555-5555-4555-8555-555555555555',
      homeId: '22222222-2222-4222-8222-222222222222',
      instructions: 'Draft a sensitive update for manager review.',
      recipient: { email: 'manager@example.test' },
      source: { kind: 'general', summary: 'Sensitive operational update.' },
      tenantId: '11111111-1111-4111-8111-111111111111',
    });

    expect(startChild).toHaveBeenCalledWith(
      'ApprovalRoutingWorkflow',
      expect.objectContaining({ taskQueue: 'careos.approvals.custom' }),
    );
  });
});
