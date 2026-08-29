import { ScheduleAlreadyRunning } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';

import {
  buildRetentionSweepSchedule,
  RETENTION_SWEEP_SCHEDULE_ID,
  registerRetentionSweepSchedule,
} from './retention-sweep.js';

describe('buildRetentionSweepSchedule', () => {
  it('defaults to a daily 02:00 cron and empty args', () => {
    const { action, spec } = buildRetentionSweepSchedule({
      taskQueue: 'careos.retention',
    });
    expect(action).toMatchObject({
      args: [{}],
      taskQueue: 'careos.retention',
      type: 'startWorkflow',
      workflowId: 'retention-sweep',
      workflowType: 'RetentionSweepWorkflow',
    });
    expect(spec).toEqual({
      cronExpressions: ['0 2 * * *'],
      timezone: 'Europe/London',
    });
  });

  it('respects custom cron expressions and task queue', () => {
    const { spec, action } = buildRetentionSweepSchedule({
      cronExpressions: ['0 3 * * *', '0 15 * * *'],
      taskQueue: 'careos.retention.dev',
      timezone: 'Europe/Paris',
    });
    expect(spec.cronExpressions).toEqual(['0 3 * * *', '0 15 * * *']);
    expect(spec.timezone).toBe('Europe/Paris');
    expect(action.taskQueue).toBe('careos.retention.dev');
  });
});

describe('registerRetentionSweepSchedule', () => {
  it('returns "created" on first registration', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn();
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerRetentionSweepSchedule
    >[0];

    const outcome = await registerRetentionSweepSchedule(client, {
      taskQueue: 'careos.retention',
    });

    expect(outcome).toBe('created');
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      policies: { overlap: 'SKIP' },
      scheduleId: RETENTION_SWEEP_SCHEDULE_ID,
    });
  });

  it('falls back to update on ScheduleAlreadyRunning, preserving prev.policies and forcing overlap:SKIP', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        new ScheduleAlreadyRunning('already running', RETENTION_SWEEP_SCHEDULE_ID),
      );
    const update = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ update });
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerRetentionSweepSchedule
    >[0];

    const outcome = await registerRetentionSweepSchedule(client, {
      taskQueue: 'careos.retention',
    });

    expect(outcome).toBe('updated');
    expect(getHandle).toHaveBeenCalledWith(RETENTION_SWEEP_SCHEDULE_ID);
    const updater = update.mock.calls[0]?.[0] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    const next = updater({ policies: { foo: 'bar' }, keepMe: true });
    expect(next).toMatchObject({
      keepMe: true,
      policies: { foo: 'bar', overlap: 'SKIP' },
    });
  });

  it('rethrows non-AlreadyRunning errors', async () => {
    const boom = new Error('temporal unreachable');
    const create = vi.fn().mockRejectedValue(boom);
    const client = {
      schedule: { create, getHandle: vi.fn() },
    } as unknown as Parameters<typeof registerRetentionSweepSchedule>[0];

    await expect(registerRetentionSweepSchedule(client, { taskQueue: 'q' })).rejects.toBe(boom);
  });
});
