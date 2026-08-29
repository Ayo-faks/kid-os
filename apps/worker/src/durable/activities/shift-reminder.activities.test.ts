import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const shiftMocks = vi.hoisted(() => ({
  loadShiftReminderContext: vi.fn(),
  markShiftReminderSent: vi.fn(),
}));
const postMattermostMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/mattermost.js', () => ({
  postMattermostMessage: postMattermostMessageMock,
}));
vi.mock('../../activities/shift-reminders.js', () => ({
  findUpcomingShifts: vi.fn(),
  ...shiftMocks,
}));

import { processShiftReminderDeliveryActivity } from './shift-reminder.activities.js';

const context = new ActivityContext('shift-reminder-test', 1);
const input = {
  correlationId: 'corr-shift-reminder',
  homeId: '22222222-2222-4222-8222-222222222222',
  nowIso: '2026-07-18T09:30:00.000Z',
  shiftId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('Durable Shift Reminder composite activity', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['missing', null, undefined, undefined, { dispatched: false, outcomeCode: 'shift-not-found' }],
    [
      'reminded',
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
  ])('returns a closed outcome for %s', async (_title, loadedResult, post, mark, expected) => {
    shiftMocks.loadShiftReminderContext.mockResolvedValue(loadedResult);
    postMattermostMessageMock.mockResolvedValue(post);
    shiftMocks.markShiftReminderSent.mockResolvedValue(mark);

    const result = await processShiftReminderDeliveryActivity(context, input);

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/private provider detail|message/i);
  });

  it('constructs the private message inside the activity and masks detailed failures', async () => {
    shiftMocks.loadShiftReminderContext.mockResolvedValue(loaded());
    postMattermostMessageMock.mockResolvedValue({ delivered: true });
    shiftMocks.markShiftReminderSent.mockResolvedValue({ recorded: true });

    await processShiftReminderDeliveryActivity(context, input);

    expect(postMattermostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: `shift-reminder:${input.shiftId}`,
        message:
          'Shift reminder: a support_worker shift starts in ~30 minutes ' +
          '(2026-07-18T10:00:00.000Z). 1 gap still need filling.',
      }),
    );

    shiftMocks.loadShiftReminderContext.mockRejectedValue(
      new Error('private shift context failed'),
    );
    await expect(processShiftReminderDeliveryActivity(context, input)).rejects.toThrow(
      'Shift reminder delivery processing failed.',
    );
  });
});

function loaded(overrides: Record<string, unknown> = {}) {
  return {
    alreadyReminded: false,
    assignedHeadcount: 1,
    minHeadcount: 2,
    requiredRole: 'support_worker',
    startsAtIso: '2026-07-18T10:00:00.000Z',
    ...overrides,
  };
}
