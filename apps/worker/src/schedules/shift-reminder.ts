// Phase 3 §2 (D3 slice 2) — schedule registration helpers.
//
// Pulled out of `scripts/register-shift-reminder-schedule.ts` so the
// worker can auto-register the schedule on boot using the same code
// path the CLI invokes. Splitting also lets us unit-test the action
// shape without spinning up a Temporal connection.

import {
  type Client,
  ScheduleAlreadyRunning,
  type ScheduleOptionsAction,
  type ScheduleSpec,
} from '@temporalio/client';

export const SHIFT_REMINDER_SCHEDULE_ID = 'careos.shift-reminder-sweep';
const SHIFT_REMINDER_WORKFLOW_TYPE = 'ShiftReminderSweepWorkflow';
const SHIFT_REMINDER_WORKFLOW_ID = 'shift-reminder-sweep';

export interface ShiftReminderScheduleOptions {
  readonly taskQueue: string;
  readonly minLookaheadMinutes?: number;
  readonly maxLookaheadMinutes?: number;
}

export interface ShiftReminderScheduleSpec {
  readonly action: ScheduleOptionsAction;
  readonly spec: ScheduleSpec;
}

export function buildShiftReminderSchedule(
  options: ShiftReminderScheduleOptions,
): ShiftReminderScheduleSpec {
  return {
    action: {
      args: [
        {
          maxLookaheadMinutes: options.maxLookaheadMinutes ?? 35,
          minLookaheadMinutes: options.minLookaheadMinutes ?? 25,
        },
      ],
      taskQueue: options.taskQueue,
      type: 'startWorkflow',
      workflowId: SHIFT_REMINDER_WORKFLOW_ID,
      workflowType: SHIFT_REMINDER_WORKFLOW_TYPE,
    },
    spec: { intervals: [{ every: '5 minutes' }] },
  };
}

export type ScheduleRegistrationOutcome = 'created' | 'updated';

// Idempotent: creates the schedule if missing, otherwise replaces the
// action + spec so cadence/argument changes survive a worker restart.
export async function registerShiftReminderSchedule(
  client: Client,
  options: ShiftReminderScheduleOptions,
): Promise<ScheduleRegistrationOutcome> {
  const { action, spec } = buildShiftReminderSchedule(options);

  try {
    await client.schedule.create({
      action,
      policies: { overlap: 'SKIP' },
      scheduleId: SHIFT_REMINDER_SCHEDULE_ID,
      spec,
    });
    return 'created';
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      const handle = client.schedule.getHandle(SHIFT_REMINDER_SCHEDULE_ID);
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
