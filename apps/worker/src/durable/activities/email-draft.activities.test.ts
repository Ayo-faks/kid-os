import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const approvalMocks = vi.hoisted(() => ({ resolveApprovalRequirementActivity: vi.fn() }));
const emailMocks = vi.hoisted(() => ({
  dispatchEmailDraftNotifications: vi.fn(),
  draftEmail: vi.fn(),
  persistEmailDraft: vi.fn(),
  validateEmailDraft: vi.fn(),
}));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/approvals.js', () => approvalMocks);
vi.mock('../../activities/email-drafts.js', () => emailMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import { processEmailDraftCommandActivity } from './email-draft.activities.js';

const context = new ActivityContext('email-draft-test', 1);
const input = {
  actor: {
    correlationId: 'corr-email',
    kind: 'user' as const,
    userId: '55555555-5555-4555-8555-555555555555',
  },
  authorUserId: '55555555-5555-4555-8555-555555555555',
  commandId: '66666666-6666-4666-8666-666666666666',
  emailDraftId: '44444444-4444-4444-8444-444444444444',
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const payload = {
  authorUserId: input.authorUserId,
  correlationId: input.actor.correlationId,
  emailDraftId: input.emailDraftId,
  homeId: input.homeId,
  instructions: 'Draft a private update for human review.',
  recipient: { email: 'guardian@example.test', name: 'Private Guardian', role: 'guardian' },
  source: { kind: 'general', summary: 'Private resident source summary.' },
  tenantId: input.tenantId,
};

describe('Durable Email Draft command activity', () => {
  beforeEach(() => {
    emailMocks.draftEmail.mockResolvedValue({
      body: 'Private generated email body for review only.',
      confidence: 0.9,
      formData: {
        body: 'Private generated email body for review only.',
        recipient: payload.recipient,
        sensitivity: 'routine',
        sensitivity_reasons: [],
        subject: 'Private update',
      },
      missingMandatory: [],
      promptHash: 'prompt-hash',
      refused: false,
      sensitivity: 'routine',
      sensitivityReasons: [],
      subject: 'Private update',
    });
    emailMocks.validateEmailDraft.mockResolvedValue({
      errors: [],
      missingMandatory: [],
      valid: true,
    });
    approvalMocks.resolveApprovalRequirementActivity.mockResolvedValue({
      level: 'none',
      requiredRoles: [],
      signaturesRequired: 0,
    });
    emailMocks.persistEmailDraft.mockResolvedValue({
      emailDraftId: input.emailDraftId,
      sensitivity: 'routine',
      status: 'draft',
    });
    emailMocks.dispatchEmailDraftNotifications.mockResolvedValue({ dispatched: false });
  });

  afterEach(() => vi.clearAllMocks());

  it('persists a routine draft while returning no recipient or body', async () => {
    useQueryResults([commandRow('pending'), emptyResult(), emptyResult(), emptyResult()]);

    const result = await processEmailDraftCommandActivity(context, input);

    expect(emailMocks.persistEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Private generated email body for review only.',
        recipient: payload.recipient,
        status: 'draft',
      }),
    );
    expect(result).toEqual({
      kind: 'state',
      state: {
        emailDraftId: input.emailDraftId,
        missingMandatory: [],
        sensitivity: 'routine',
        status: 'draft',
      },
    });
    expect(JSON.stringify(result)).not.toContain('guardian@example.test');
    expect(JSON.stringify(result)).not.toContain('generated email body');
  });

  it('returns only an ID-based Approval request for a sensitive draft', async () => {
    useQueryResults([commandRow('pending'), emptyResult(), emptyResult(), emptyResult()]);
    emailMocks.draftEmail.mockResolvedValue({
      ...emailMocks.draftEmail.getMockImplementation()?.(),
      body: 'Sensitive safeguarding email body for review.',
      formData: {},
      missingMandatory: [],
      promptHash: 'sensitive-prompt',
      refused: false,
      sensitivity: 'sensitive',
      sensitivityReasons: ['safeguarding'],
      subject: 'Safeguarding review',
    });
    approvalMocks.resolveApprovalRequirementActivity.mockResolvedValue({
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
    });
    emailMocks.persistEmailDraft.mockResolvedValue({
      emailDraftId: input.emailDraftId,
      sensitivity: 'sensitive',
      status: 'needs_review',
    });

    const result = await processEmailDraftCommandActivity(context, input);

    expect(result).toMatchObject({
      approval: {
        approvalId: input.emailDraftId,
        requiredRoles: ['manager', 'safeguarding_lead'],
        signaturesRequired: 2,
        subjectId: input.emailDraftId,
        subjectType: 'email_draft',
      },
      kind: 'await_approval',
      state: { sensitivity: 'sensitive', status: 'needs_review' },
    });
    expect(JSON.stringify(result)).not.toContain('Safeguarding review');
    expect(JSON.stringify(result)).not.toContain('safeguarding email body');
  });

  it('rehydrates an applied sensitive draft without calling Hermes again', async () => {
    useQueryResults([
      commandRow('applied'),
      { rowCount: 1, rows: [{ sensitivity: 'sensitive', status: 'needs_review' }] },
    ]);
    approvalMocks.resolveApprovalRequirementActivity.mockResolvedValue({
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
    });

    await expect(processEmailDraftCommandActivity(context, input)).resolves.toMatchObject({
      kind: 'await_approval',
      state: { status: 'needs_review' },
    });
    expect(emailMocks.draftEmail).not.toHaveBeenCalled();
  });

  it('records refusal without persisting a draft', async () => {
    useQueryResults([commandRow('pending'), emptyResult(), emptyResult(), emptyResult()]);
    emailMocks.draftEmail.mockResolvedValue({
      body: '',
      confidence: 0,
      formData: {},
      missingMandatory: ['subject', 'body'],
      promptHash: 'refused-prompt',
      refused: true,
      sensitivity: 'sensitive',
      sensitivityReasons: [],
      subject: '',
    });

    await expect(processEmailDraftCommandActivity(context, input)).resolves.toMatchObject({
      kind: 'state',
      state: {
        missingMandatory: ['subject', 'body'],
        outcomeCode: 'refused',
        status: 'failed',
      },
    });
    expect(emailMocks.persistEmailDraft).not.toHaveBeenCalled();
  });

  it('stores provider detail but throws only a generic scheduler error', async () => {
    const query = useQueryResults([commandRow('pending'), emptyResult(), emptyResult()]);
    emailMocks.draftEmail.mockRejectedValue(new Error('Provider echoed private email body'));

    await expect(processEmailDraftCommandActivity(context, input)).rejects.toThrow(
      'Email draft command processing failed.',
    );
    expect(query.mock.calls.at(-1)?.[1]).toContain('Provider echoed private email body');
  });
});

function commandRow(status: 'pending' | 'processing' | 'applied' | 'failed') {
  return { rowCount: 1, rows: [{ failure_reason: null, payload, status }] };
}

function emptyResult() {
  return { rowCount: 1, rows: [] };
}

function useQueryResults(
  results: Array<{ readonly rowCount: number; readonly rows: readonly unknown[] }>,
) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  withTenantContextMock.mockImplementation(
    (_context: unknown, callback: (client: { query: typeof query }) => Promise<unknown>) =>
      callback({ query }),
  );
  return query;
}
