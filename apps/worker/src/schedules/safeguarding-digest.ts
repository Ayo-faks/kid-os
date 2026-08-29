// Phase 3 §3 (D3 slice 6) — weekly safeguarding digest schedule.

import {
  type Client,
  ScheduleAlreadyRunning,
  type ScheduleOptionsAction,
  type ScheduleSpec,
} from '@temporalio/client';

export const SAFEGUARDING_DIGEST_SCHEDULE_ID = 'careos.safeguarding-digest-sweep';
const SAFEGUARDING_DIGEST_WORKFLOW_TYPE = 'SafeguardingDigestSweepWorkflow';
const SAFEGUARDING_DIGEST_WORKFLOW_ID = 'safeguarding-digest-sweep';

export interface SafeguardingDigestScheduleOptions {
  readonly taskQueue: string;
  readonly windowMinutes?: number;
  readonly cronExpressions?: readonly string[];
  readonly timezone?: string;
}

export interface SafeguardingDigestScheduleSpec {
  readonly action: ScheduleOptionsAction;
  readonly spec: ScheduleSpec;
}

export function buildSafeguardingDigestSchedule(
  options: SafeguardingDigestScheduleOptions,
): SafeguardingDigestScheduleSpec {
  const cronExpressions = options.cronExpressions ?? ['0 8 * * MON'];
  return {
    action: {
      args: [
        {
          windowMinutes: options.windowMinutes ?? 7 * 24 * 60,
        },
      ],
      taskQueue: options.taskQueue,
      type: 'startWorkflow',
      workflowId: SAFEGUARDING_DIGEST_WORKFLOW_ID,
      workflowType: SAFEGUARDING_DIGEST_WORKFLOW_TYPE,
    },
    spec: {
      cronExpressions: [...cronExpressions],
      timezone: options.timezone ?? 'Europe/London',
    },
  };
}

export type ScheduleRegistrationOutcome = 'created' | 'updated';

export async function registerSafeguardingDigestSchedule(
  client: Client,
  options: SafeguardingDigestScheduleOptions,
): Promise<ScheduleRegistrationOutcome> {
  const { action, spec } = buildSafeguardingDigestSchedule(options);

  try {
    await client.schedule.create({
      action,
      policies: { overlap: 'SKIP' },
      scheduleId: SAFEGUARDING_DIGEST_SCHEDULE_ID,
      spec,
    });
    return 'created';
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      const handle = client.schedule.getHandle(SAFEGUARDING_DIGEST_SCHEDULE_ID);
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
