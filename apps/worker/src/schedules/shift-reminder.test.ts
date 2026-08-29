import { ScheduleAlreadyRunning } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';

import {
  buildShiftReminderSchedule,
  registerShiftReminderSchedule,
  SHIFT_REMINDER_SCHEDULE_ID,
} from './shift-reminder.js';

describe('buildShiftReminderSchedule', () => {
  it('builds a startWorkflow action with default lookahead window', () => {
    const { action, spec } = buildShiftReminderSchedule({
      taskQueue: 'careos.notifications',
    });
    expect(action).toMatchObject({
      args: [{ minLookaheadMinutes: 25, maxLookaheadMinutes: 35 }],
      taskQueue: 'careos.notifications',
      type: 'startWorkflow',
      workflowId: 'shift-reminder-sweep',
      workflowType: 'ShiftReminderSweepWorkflow',
    });
    expect(spec).toEqual({ intervals: [{ every: '5 minutes' }] });
  });

  it('respects custom lookahead bounds', () => {
    const { action } = buildShiftReminderSchedule({
      maxLookaheadMinutes: 90,
      minLookaheadMinutes: 60,
      taskQueue: 'careos.notifications.dev',
    });
    expect(action.args?.[0]).toEqual({
      maxLookaheadMinutes: 90,
      minLookaheadMinutes: 60,
    });
    expect(action.taskQueue).toBe('careos.notifications.dev');
  });
});

describe('registerShiftReminderSchedule', () => {
  it('returns "created" when the schedule does not yet exist', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn();
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerShiftReminderSchedule
    >[0];

    const outcome = await registerShiftReminderSchedule(client, {
      taskQueue: 'careos.notifications',
    });

    expect(outcome).toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      scheduleId: SHIFT_REMINDER_SCHEDULE_ID,
      policies: { overlap: 'SKIP' },
    });
    expect(getHandle).not.toHaveBeenCalled();
  });

  it('updates the existing schedule when create reports it already runs', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(new ScheduleAlreadyRunning('already running', SHIFT_REMINDER_SCHEDULE_ID));
    const update = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ update });
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerShiftReminderSchedule
    >[0];

    const outcome = await registerShiftReminderSchedule(client, {
      taskQueue: 'careos.notifications',
    });

    expect(outcome).toBe('updated');
    expect(getHandle).toHaveBeenCalledWith(SHIFT_REMINDER_SCHEDULE_ID);
    expect(update).toHaveBeenCalledTimes(1);
    const updater = update.mock.calls[0]?.[0] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    const next = updater({ policies: { foo: 'bar' }, irrelevant: true });
    expect(next).toMatchObject({
      irrelevant: true,
      policies: { foo: 'bar', overlap: 'SKIP' },
    });
  });

  it('rethrows any non-AlreadyRunning error from create', async () => {
    const boom = new Error('temporal unreachable');
    const create = vi.fn().mockRejectedValue(boom);
    const getHandle = vi.fn();
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerShiftReminderSchedule
    >[0];

    await expect(registerShiftReminderSchedule(client, { taskQueue: 'q' })).rejects.toBe(boom);
    expect(getHandle).not.toHaveBeenCalled();
  });
});
