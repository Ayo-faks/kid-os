import { ScheduleAlreadyRunning } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSafeguardingDigestSchedule,
  registerSafeguardingDigestSchedule,
  SAFEGUARDING_DIGEST_SCHEDULE_ID,
} from './safeguarding-digest.js';

describe('buildSafeguardingDigestSchedule', () => {
  it('builds a weekly Monday 08:00 cron action by default', () => {
    const { action, spec } = buildSafeguardingDigestSchedule({
      taskQueue: 'careos.notifications',
    });
    expect(action).toMatchObject({
      args: [{ windowMinutes: 7 * 24 * 60 }],
      taskQueue: 'careos.notifications',
      type: 'startWorkflow',
      workflowId: 'safeguarding-digest-sweep',
      workflowType: 'SafeguardingDigestSweepWorkflow',
    });
    expect(spec).toEqual({
      cronExpressions: ['0 8 * * MON'],
      timezone: 'Europe/London',
    });
  });

  it('respects custom window and cron overrides', () => {
    const { action, spec } = buildSafeguardingDigestSchedule({
      cronExpressions: ['0 9 * * FRI'],
      taskQueue: 'careos.notifications.dev',
      timezone: 'Europe/Paris',
      windowMinutes: 60,
    });
    expect(action.args?.[0]).toEqual({ windowMinutes: 60 });
    expect(action.taskQueue).toBe('careos.notifications.dev');
    expect(spec).toEqual({
      cronExpressions: ['0 9 * * FRI'],
      timezone: 'Europe/Paris',
    });
  });
});

describe('registerSafeguardingDigestSchedule', () => {
  it('returns "created" when the schedule does not yet exist', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn();
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerSafeguardingDigestSchedule
    >[0];

    const outcome = await registerSafeguardingDigestSchedule(client, {
      taskQueue: 'careos.notifications',
    });

    expect(outcome).toBe('created');
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      scheduleId: SAFEGUARDING_DIGEST_SCHEDULE_ID,
      policies: { overlap: 'SKIP' },
    });
  });

  it('updates the existing schedule when create reports it already runs', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        new ScheduleAlreadyRunning('already running', SAFEGUARDING_DIGEST_SCHEDULE_ID),
      );
    const update = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ update });
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerSafeguardingDigestSchedule
    >[0];

    const outcome = await registerSafeguardingDigestSchedule(client, {
      taskQueue: 'careos.notifications',
    });

    expect(outcome).toBe('updated');
    expect(getHandle).toHaveBeenCalledWith(SAFEGUARDING_DIGEST_SCHEDULE_ID);
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
      typeof registerSafeguardingDigestSchedule
    >[0];

    await expect(registerSafeguardingDigestSchedule(client, { taskQueue: 'q' })).rejects.toBe(boom);
    expect(getHandle).not.toHaveBeenCalled();
  });
});
