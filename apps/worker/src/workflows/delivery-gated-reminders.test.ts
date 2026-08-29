import { beforeEach, describe, expect, it, vi } from 'vitest';

const activities = vi.hoisted(() => ({
  findIncidentsMissingMandatoryFields: vi.fn(),
  findOverdueHandoverShifts: vi.fn(),
  findUpcomingShifts: vi.fn(),
  loadHandoverDueReminderContext: vi.fn(),
  loadMissingFieldsContext: vi.fn(),
  loadShiftReminderContext: vi.fn(),
  markHandoverDueReminderSent: vi.fn(),
  markMissingFieldsReminderSent: vi.fn(),
  markShiftReminderSent: vi.fn(),
  postMattermostMessage: vi.fn(),
}));

vi.mock('@temporalio/workflow', () => ({
  ChildWorkflowCancellationType: { ABANDON: 'ABANDON' },
  ParentClosePolicy: { PARENT_CLOSE_POLICY_ABANDON: 'ABANDON' },
  proxyActivities: vi.fn(() => activities),
  startChild: vi.fn(),
  workflowInfo: vi.fn(() => ({ runId: 'run-1' })),
}));

import { SendHandoverDueReminderWorkflow } from './handover-due-reminder.workflow.js';
import { SendMissingFieldsReminderWorkflow } from './missing-fields-audit.workflow.js';
import { SendShiftReminderWorkflow } from './shift-reminder.workflow.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const shiftId = '33333333-3333-4333-8333-333333333333';
const incidentId = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  activities.postMattermostMessage.mockResolvedValue({
    delivered: false,
    providerKind: 'disabled',
    reason: 'mattermost-disabled',
  });
});

describe('delivery-gated reminder workflows', () => {
  it('does not mark a shift reminder sent when Mattermost does not deliver', async () => {
    activities.loadShiftReminderContext.mockResolvedValue({
      alreadyReminded: false,
      assignedHeadcount: 1,
      minHeadcount: 2,
      requiredRole: 'support_worker',
      startsAtIso: '2026-07-15T18:00:00.000Z',
    });

    await expect(
      SendShiftReminderWorkflow({
        correlationId: 'corr-shift',
        homeId,
        shiftId,
        tenantId,
      }),
    ).resolves.toEqual({ dispatched: false, reason: 'mattermost-disabled' });
    expect(activities.markShiftReminderSent).not.toHaveBeenCalled();
  });

  it('does not mark a handover reminder sent when Mattermost does not deliver', async () => {
    activities.loadHandoverDueReminderContext.mockResolvedValue({
      alreadyReminded: false,
      endsAtIso: '2026-07-15T12:00:00.000Z',
      handoverRecorded: false,
      requiredRole: 'shift_lead',
    });

    await expect(
      SendHandoverDueReminderWorkflow({
        correlationId: 'corr-handover',
        homeId,
        shiftId,
        tenantId,
      }),
    ).resolves.toEqual({ dispatched: false, reason: 'mattermost-disabled' });
    expect(activities.markHandoverDueReminderSent).not.toHaveBeenCalled();
  });

  it('does not mark a missing-fields reminder sent when Mattermost does not deliver', async () => {
    activities.loadMissingFieldsContext.mockResolvedValue({
      alreadyReminded: false,
      createdAtIso: '2026-07-14T12:00:00.000Z',
      incidentId,
      missingFields: ['occurredAt'],
      status: 'awaiting_fields',
    });

    await expect(
      SendMissingFieldsReminderWorkflow({
        correlationId: 'corr-fields',
        homeId,
        incidentId,
        tenantId,
      }),
    ).resolves.toEqual({ dispatched: false, reason: 'mattermost-disabled' });
    expect(activities.markMissingFieldsReminderSent).not.toHaveBeenCalled();
  });

  it('marks a delivered shift reminder exactly once', async () => {
    activities.loadShiftReminderContext.mockResolvedValue({
      alreadyReminded: false,
      assignedHeadcount: 2,
      minHeadcount: 2,
      requiredRole: 'support_worker',
      startsAtIso: '2026-07-15T18:00:00.000Z',
    });
    activities.postMattermostMessage.mockResolvedValue({
      channelId: 'channel-1',
      delivered: true,
      providerKind: 'http',
      providerMessageId: 'post-1',
    });
    activities.markShiftReminderSent.mockResolvedValue({ recorded: true });

    await expect(
      SendShiftReminderWorkflow({
        correlationId: 'corr-delivered',
        homeId,
        shiftId,
        tenantId,
      }),
    ).resolves.toEqual({ dispatched: true, reason: undefined });
    expect(activities.markShiftReminderSent).toHaveBeenCalledTimes(1);
  });
});
