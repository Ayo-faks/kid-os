import { ScheduleAlreadyRunning } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';

import {
  buildMissingFieldsAuditSchedule,
  MISSING_FIELDS_AUDIT_SCHEDULE_ID,
  registerMissingFieldsAuditSchedule,
} from './missing-fields-audit.js';

describe('buildMissingFieldsAuditSchedule', () => {
  it('builds a startWorkflow action with the default 24h cutoff', () => {
    const { action, spec } = buildMissingFieldsAuditSchedule({
      taskQueue: 'careos.notifications',
    });
    expect(action).toMatchObject({
      args: [{ minAgeMinutes: 1440 }],
      taskQueue: 'careos.notifications',
      type: 'startWorkflow',
      workflowId: 'missing-fields-audit-sweep',
      workflowType: 'MissingFieldsAuditSweepWorkflow',
    });
    expect(spec).toEqual({ intervals: [{ every: '60 minutes' }] });
  });

  it('respects custom min-age and interval overrides', () => {
    const { action, spec } = buildMissingFieldsAuditSchedule({
      intervalMinutes: 15,
      minAgeMinutes: 720,
      taskQueue: 'careos.notifications.dev',
    });
    expect(action.args?.[0]).toEqual({ minAgeMinutes: 720 });
    expect(action.taskQueue).toBe('careos.notifications.dev');
    expect(spec).toEqual({ intervals: [{ every: '15 minutes' }] });
  });
});

describe('registerMissingFieldsAuditSchedule', () => {
  it('returns "created" when the schedule does not yet exist', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn();
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerMissingFieldsAuditSchedule
    >[0];

    const outcome = await registerMissingFieldsAuditSchedule(client, {
      taskQueue: 'careos.notifications',
    });

    expect(outcome).toBe('created');
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      scheduleId: MISSING_FIELDS_AUDIT_SCHEDULE_ID,
      policies: { overlap: 'SKIP' },
    });
  });

  it('updates the existing schedule when create reports it already runs', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        new ScheduleAlreadyRunning('already running', MISSING_FIELDS_AUDIT_SCHEDULE_ID),
      );
    const update = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ update });
    const client = { schedule: { create, getHandle } } as unknown as Parameters<
      typeof registerMissingFieldsAuditSchedule
    >[0];

    const outcome = await registerMissingFieldsAuditSchedule(client, {
      taskQueue: 'careos.notifications',
    });

    expect(outcome).toBe('updated');
    expect(getHandle).toHaveBeenCalledWith(MISSING_FIELDS_AUDIT_SCHEDULE_ID);
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
      typeof registerMissingFieldsAuditSchedule
    >[0];

    await expect(registerMissingFieldsAuditSchedule(client, { taskQueue: 'q' })).rejects.toBe(boom);
    expect(getHandle).not.toHaveBeenCalled();
  });
});
