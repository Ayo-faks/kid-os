import { beforeEach, describe, expect, it, vi } from 'vitest';

const activities = vi.hoisted(() => ({
  ensureFollowUpExportBundle: vi.fn(),
  loadSafeguardingContact: vi.fn(),
  transitionIncidentFollowUp: vi.fn(),
}));
const startChildMock = vi.hoisted(() => vi.fn());

vi.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: { ABANDON: 'ABANDON' },
  proxyActivities: vi.fn(() => activities),
  startChild: startChildMock,
}));

import { IncidentFollowUpActionWorkflow } from './incident-follow-up-action.workflow.js';

const base = {
  actionId: '11111111-1111-4111-8111-111111111111',
  attempt: 1,
  correlationId: 'corr-follow-up-workflow',
  homeId: '44444444-4444-4444-8444-444444444444',
  incidentId: '55555555-5555-4555-8555-555555555555',
  requestedByUserId: '66666666-6666-4666-8666-666666666666',
  targetId: '22222222-2222-4222-8222-222222222222',
  tenantId: '77777777-7777-4777-8777-777777777777',
} as const;

describe('IncidentFollowUpActionWorkflow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks email action needs_configuration without starting or guessing a recipient', async () => {
    activities.loadSafeguardingContact.mockResolvedValueOnce({ configured: false });

    await expect(
      IncidentFollowUpActionWorkflow({ ...base, kind: 'safeguarding_email' }),
    ).resolves.toEqual({ actionId: base.actionId, status: 'needs_configuration' });

    expect(startChildMock).not.toHaveBeenCalled();
    expect(activities.transitionIncidentFollowUp).toHaveBeenLastCalledWith(
      expect.objectContaining({
        failureCode: 'safeguarding-contact-not-configured',
        status: 'needs_configuration',
      }),
    );
  });

  it('starts a system-attributed sensitive draft and leaves it awaiting human approval', async () => {
    activities.loadSafeguardingContact.mockResolvedValueOnce({
      configured: true,
      email: 'dsl@willow.example',
      name: 'Willow safeguarding lead',
    });
    startChildMock.mockResolvedValueOnce({ result: () => Promise.resolve() });

    await expect(
      IncidentFollowUpActionWorkflow({ ...base, kind: 'safeguarding_email' }),
    ).resolves.toEqual({
      actionId: base.actionId,
      status: 'awaiting_approval',
      targetId: base.targetId,
    });

    expect(startChildMock).toHaveBeenCalledWith(
      'EmailDraftWorkflow',
      expect.objectContaining({
        args: [
          expect.objectContaining({
            actor: expect.objectContaining({ kind: 'system', userId: null }),
            authorUserId: base.requestedByUserId,
            preparedDraft: expect.objectContaining({
              sensitivity: 'sensitive',
              subject: 'Safeguarding incident review',
            }),
            recipient: expect.objectContaining({ email: 'dsl@willow.example' }),
          }),
        ],
        taskQueue: 'careos.emails',
        workflowId: `email-draft-${base.targetId}`,
      }),
    );
  });

  it('builds and records the signed export independently', async () => {
    startChildMock.mockResolvedValueOnce({ result: () => Promise.resolve({ status: 'ready' }) });

    await expect(
      IncidentFollowUpActionWorkflow({ ...base, kind: 'export_bundle' }),
    ).resolves.toEqual({
      actionId: base.actionId,
      status: 'completed',
      targetId: base.targetId,
    });

    expect(activities.ensureFollowUpExportBundle).toHaveBeenCalledOnce();
    expect(startChildMock).toHaveBeenCalledWith(
      'SeriousIncidentExportWorkflow',
      expect.objectContaining({
        taskQueue: 'careos.export-bundles',
        workflowId: `serious-incident-export-${base.targetId}`,
      }),
    );
    expect(activities.transitionIncidentFollowUp).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'completed', targetId: base.targetId }),
    );
  });
});
