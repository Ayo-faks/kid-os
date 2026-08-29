import { ActivityContext, OrchestrationStatus } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const handoverMocks = vi.hoisted(() => ({
  findOverdueHandoverShifts: vi.fn(),
  loadHandoverDueReminderContext: vi.fn(),
  markHandoverDueReminderSent: vi.fn(),
}));
const postMattermostMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/handover-due-reminders.js', () => handoverMocks);
vi.mock('../../activities/mattermost.js', () => ({
  postMattermostMessage: postMattermostMessageMock,
}));

import {
  createStartHandoverDueDeliveryActivity,
  findHandoverDueTargetsActivity,
  processHandoverDueDeliveryActivity,
} from './handover-due-reminder.activities.js';

const context = new ActivityContext('handover-due-test', 1);
const input = {
  correlationId: 'corr-handover-due',
  homeId: '22222222-2222-4222-8222-222222222222',
  nowIso: '2026-07-18T10:30:00.000Z',
  shiftId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('Durable Handover Due activities', () => {
  afterEach(() => vi.clearAllMocks());

  it('strips role and timestamps from scheduler-visible sweep targets', async () => {
    handoverMocks.findOverdueHandoverShifts.mockResolvedValue({
      shifts: [
        {
          endsAtIso: '2026-07-18T10:00:00.000Z',
          homeId: input.homeId,
          requiredRole: 'private-role-text',
          shiftId: input.shiftId,
          tenantId: input.tenantId,
        },
      ],
    });

    const result = await findHandoverDueTargetsActivity(context, {
      correlationId: input.correlationId,
      maxOverdueMinutes: 240,
      minOverdueMinutes: 15,
      nowIso: input.nowIso,
    });

    expect(result).toEqual({
      targets: [{ homeId: input.homeId, shiftId: input.shiftId, tenantId: input.tenantId }],
    });
    expect(JSON.stringify(result)).not.toContain('private-role-text');
  });

  it.each([
    [
      'missing shift',
      null,
      undefined,
      undefined,
      { dispatched: false, outcomeCode: 'shift-not-found' },
    ],
    [
      'recorded handover',
      loaded({ handoverRecorded: true }),
      undefined,
      undefined,
      { dispatched: false, outcomeCode: 'handover-already-recorded' },
    ],
    [
      'already reminded',
      loaded({ alreadyReminded: true }),
      undefined,
      undefined,
      { dispatched: false, outcomeCode: 'already-reminded' },
    ],
    [
      'provider failure',
      loaded(),
      { delivered: false, reason: 'private provider detail' },
      undefined,
      { dispatched: false, outcomeCode: 'provider-not-delivered' },
    ],
    ['delivery', loaded(), { delivered: true }, { recorded: true }, { dispatched: true }],
  ])('returns a closed outcome for %s', async (_title, contextResult, post, mark, expected) => {
    handoverMocks.loadHandoverDueReminderContext.mockResolvedValue(contextResult);
    postMattermostMessageMock.mockResolvedValue(post);
    handoverMocks.markHandoverDueReminderSent.mockResolvedValue(mark);

    const result = await processHandoverDueDeliveryActivity(context, input);

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain('private provider detail');
    if (post !== undefined) {
      expect(postMattermostMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: `handover-due-reminder:${input.shiftId}` }),
      );
    }
  });

  it('reconciles a lost detached-delivery start acknowledgement', async () => {
    const deliveryInstanceId = `handover-due-reminder:${input.shiftId}`;
    const client = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValue({ runtimeStatus: OrchestrationStatus.RUNNING }),
      scheduleNewOrchestration: vi.fn().mockRejectedValue(new Error('response lost')),
    };

    await expect(
      createStartHandoverDueDeliveryActivity(client)(context, {
        correlationId: input.correlationId,
        deliveryInstanceId,
        homeId: input.homeId,
        shiftId: input.shiftId,
        tenantId: input.tenantId,
      }),
    ).resolves.toBe(deliveryInstanceId);
  });
});

function loaded(overrides: Record<string, unknown> = {}) {
  return {
    alreadyReminded: false,
    endsAtIso: '2026-07-18T10:00:00.000Z',
    handoverRecorded: false,
    requiredRole: 'support_worker',
    shiftId: input.shiftId,
    ...overrides,
  };
}
