// Phase 4 §3 — Retention sweep daily schedule.

import {
  type Client,
  ScheduleAlreadyRunning,
  type ScheduleOptionsAction,
  type ScheduleSpec,
} from '@temporalio/client';

export const RETENTION_SWEEP_SCHEDULE_ID = 'careos.retention-sweep';
const RETENTION_SWEEP_WORKFLOW_TYPE = 'RetentionSweepWorkflow';
const RETENTION_SWEEP_WORKFLOW_ID = 'retention-sweep';

export interface RetentionSweepScheduleOptions {
  readonly taskQueue: string;
  readonly cronExpressions?: readonly string[];
  readonly timezone?: string;
}

export interface RetentionSweepScheduleSpec {
  readonly action: ScheduleOptionsAction;
  readonly spec: ScheduleSpec;
}

export function buildRetentionSweepSchedule(
  options: RetentionSweepScheduleOptions,
): RetentionSweepScheduleSpec {
  const cronExpressions = options.cronExpressions ?? ['0 2 * * *'];
  return {
    action: {
      args: [{}],
      taskQueue: options.taskQueue,
      type: 'startWorkflow',
      workflowId: RETENTION_SWEEP_WORKFLOW_ID,
      workflowType: RETENTION_SWEEP_WORKFLOW_TYPE,
    },
    spec: {
      cronExpressions: [...cronExpressions],
      timezone: options.timezone ?? 'Europe/London',
    },
  };
}

export type ScheduleRegistrationOutcome = 'created' | 'updated';

export async function registerRetentionSweepSchedule(
  client: Client,
  options: RetentionSweepScheduleOptions,
): Promise<ScheduleRegistrationOutcome> {
  const { action, spec } = buildRetentionSweepSchedule(options);

  try {
    await client.schedule.create({
      action,
      policies: { overlap: 'SKIP' },
      scheduleId: RETENTION_SWEEP_SCHEDULE_ID,
      spec,
    });
    return 'created';
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      const handle = client.schedule.getHandle(RETENTION_SWEEP_SCHEDULE_ID);
      await handle.update((prev) => ({
        ...prev,
        action,
        policies: { ...prev.policies, overlap: 'SKIP' },
        spec,
      }));
      return 'updated';
    }
    throw error;
  }
}
