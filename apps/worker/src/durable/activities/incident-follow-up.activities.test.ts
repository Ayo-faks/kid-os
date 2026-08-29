import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const approvalMocks = vi.hoisted(() => ({ resolveApprovalRequirementActivity: vi.fn() }));
const emailMocks = vi.hoisted(() => ({
  dispatchEmailDraftNotifications: vi.fn(),
  persistEmailDraft: vi.fn(),
  validateEmailDraft: vi.fn(),
}));
const exportMocks = vi.hoisted(() => ({
  composeExportBundle: vi.fn(),
  markExportBundleBuilding: vi.fn(),
  markExportBundleFailed: vi.fn(),
  markExportBundleReady: vi.fn(),
}));
const followUpMocks = vi.hoisted(() => ({
  ensureFollowUpExportBundle: vi.fn(),
  loadSafeguardingContact: vi.fn(),
  transitionIncidentFollowUp: vi.fn(),
}));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/approvals.js', () => approvalMocks);
vi.mock('../../activities/email-drafts.js', () => emailMocks);
vi.mock('../../activities/export-bundles.js', () => exportMocks);
vi.mock('../../activities/incident-follow-ups.js', () => followUpMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import {
  createStartIncidentFollowUpActionActivity,
  processIncidentFollowUpActionActivity,
} from './incident-follow-up.activities.js';

const context = new ActivityContext('follow-up-test', 1);
const base = {
  actionId: '11111111-1111-4111-8111-111111111111',
  attempt: 1,
  correlationId: 'corr-follow-up',
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '33333333-3333-4333-8333-333333333333',
  requestedByUserId: '44444444-4444-4444-8444-444444444444',
  targetId: '55555555-5555-4555-8555-555555555555',
  tenantId: '66666666-6666-4666-8666-666666666666',
} as const;

describe('Durable Incident follow-up activities', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns needs-configuration without exposing or guessing contact data', async () => {
    followUpMocks.loadSafeguardingContact.mockResolvedValue({ configured: false });

    const result = await processIncidentFollowUpActionActivity(context, {
      ...base,
      kind: 'safeguarding_email',
    });

    expect(result).toEqual({ kind: 'terminal', status: 'needs_configuration' });
    expect(emailMocks.persistEmailDraft).not.toHaveBeenCalled();
  });

  it('persists a prepared sensitive email and returns only its Approval reference', async () => {
    followUpMocks.loadSafeguardingContact.mockResolvedValue({
      configured: true,
      email: 'dsl@willow.example',
      name: 'Willow safeguarding lead',
    });
    emailMocks.validateEmailDraft.mockResolvedValue({
      errors: [],
      missingMandatory: [],
      valid: true,
    });
    approvalMocks.resolveApprovalRequirementActivity.mockResolvedValue({
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
    });
    emailMocks.persistEmailDraft.mockResolvedValue({
      emailDraftId: base.targetId,
      sensitivity: 'sensitive',
      status: 'needs_review',
    });
    emailMocks.dispatchEmailDraftNotifications.mockResolvedValue({ dispatched: true });

    const result = await processIncidentFollowUpActionActivity(context, {
      ...base,
      kind: 'safeguarding_email',
    });

    expect(emailMocks.persistEmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        emailDraftId: base.targetId,
        recipient: {
          email: 'dsl@willow.example',
          name: 'Willow safeguarding lead',
          role: 'safeguarding_contact',
        },
        sensitivity: 'sensitive',
        status: 'needs_review',
      }),
    );
    expect(result).toMatchObject({
      approval: {
        approvalId: base.targetId,
        requiredRoles: ['manager', 'safeguarding_lead'],
        signaturesRequired: 2,
        subjectId: base.targetId,
        subjectType: 'email_draft',
      },
      kind: 'await_approval',
    });
    expect(JSON.stringify(result)).not.toContain('dsl@willow.example');
    expect(JSON.stringify(result)).not.toContain('Willow safeguarding lead');
  });

  it('composes and records a signed export bundle inside the activity boundary', async () => {
    exportMocks.composeExportBundle.mockResolvedValue({
      manifestSha256: 'manifest-sha',
      objectKey: 'tenants/t/incidents/i/bundles/b.zip',
      retainUntilIso: '2033-07-18T00:00:00.000Z',
      signature: 'signature',
      signatureAlgorithm: 'HMAC-SHA256',
      sizeBytes: 1024,
    });

    await expect(
      processIncidentFollowUpActionActivity(context, { ...base, kind: 'export_bundle' }),
    ).resolves.toEqual({ kind: 'terminal', status: 'completed' });

    expect(followUpMocks.ensureFollowUpExportBundle).toHaveBeenCalledOnce();
    expect(exportMocks.markExportBundleReady).toHaveBeenCalledWith(
      expect.objectContaining({ manifestSha256: 'manifest-sha', sizeBytes: 1024 }),
    );
  });

  it('starts the detached follow-up with a retry-stable instance id', async () => {
    const client = {
      getOrchestrationState: vi.fn(),
      scheduleNewOrchestration: vi.fn().mockResolvedValue('follow-up-instance'),
    };
    const start = createStartIncidentFollowUpActionActivity(client);

    await expect(
      start(context, {
        ...base,
        kind: 'export_bundle',
        workflowId: 'incident-follow-up-action-1',
      }),
    ).resolves.toBe('follow-up-instance');

    expect(client.scheduleNewOrchestration).toHaveBeenCalledWith(
      'IncidentFollowUpActionOrchestratorV1',
      { ...base, kind: 'export_bundle' },
      { instanceId: 'incident-follow-up-action-1', version: '1.0.0' },
    );
  });
});
