import { ScheduleAlreadyRunning } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';

import {
  buildHandoverDueReminderSchedule,
  HANDOVER_DUE_REMINDER_SCHEDULE_ID,
  registerHandoverDueReminderSchedule,
} from './handover-due-reminder.js';

describe('buildHandoverDueReminderSchedule', () => {
  it('builds a startWorkflow action with default overdue window', () => {
    const { action, spec } = buildHandoverDueReminderSchedule({
      taskQueue: 'careos.notifications',
    });
    expect(action).toMatchObject({
      args: [{ minOverdueMinutes: 15, maxOverdueMinutes: 240 }],
      taskQueue: 'careos.notifications',
      type: 'startWorkflow',
      workflowId: 'handover-due-reminder-sweep',
      workflowType: 'HandoverDueReminderSweepWorkflow',
    });
    expect(spec).toEqual({ intervals: [{ every: '10 minutes' }] });
  });

  it('respects custom min/max overrides', () => {
    const { action } = buildHandoverDueReminderSchedule({
      maxOverdueMinutes: 360,
      minOverdueMinutes: 30,
      taskQueue: 'careos.notifications.dev',
    });
    expect(action.args?.[0]).toEqual({
      maxOverdueMinutes: 360,
      minOverdueMinutes: 30,
    });
    expect(action.taskQueue).toBe('careos.notifications.dev');
  });
});

describe('registerHandoverDueReminderSchedule', () => {
  it('returns "created" when the schedule does not yet exist', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn();
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerHandoverDueReminderSchedule
    >[0];

    const outcome = await registerHandoverDueReminderSchedule(client, {
      taskQueue: 'careos.notifications',
    });

    expect(outcome).toBe('created');
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      scheduleId: HANDOVER_DUE_REMINDER_SCHEDULE_ID,
      policies: { overlap: 'SKIP' },
    });
  });

  it('updates the existing schedule when create reports it already runs', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        new ScheduleAlreadyRunning('already running', HANDOVER_DUE_REMINDER_SCHEDULE_ID),
      );
    const update = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ update });
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerHandoverDueReminderSchedule
    >[0];

    const outcome = await registerHandoverDueReminderSchedule(client, {
      taskQueue: 'careos.notifications',
    });

    expect(outcome).toBe('updated');
    expect(getHandle).toHaveBeenCalledWith(HANDOVER_DUE_REMINDER_SCHEDULE_ID);
    const updater = update.mock.calls[0]?.[0] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    const next = updater({ policies: { foo: 'bar' } });
    expect(next.policies).toEqual({ foo: 'bar', overlap: 'SKIP' });
  });

  it('rethrows non-AlreadyRunning errors from create', async () => {
    const boom = new Error('temporal unreachable');
    const create = vi.fn().mockRejectedValue(boom);
    const getHandle = vi.fn();
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerHandoverDueReminderSchedule
    >[0];

    await expect(registerHandoverDueReminderSchedule(client, { taskQueue: 'q' })).rejects.toBe(
      boom,
    );
    expect(getHandle).not.toHaveBeenCalled();
  });
});
