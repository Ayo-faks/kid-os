// Phase 3 §2 (D3 slice 3) — overdue-handover schedule registration.
//
// Mirrors `schedules/shift-reminder.ts` so the worker auto-registers
// both sweeps on boot using the same helper pattern.

import {
  type Client,
  ScheduleAlreadyRunning,
  type ScheduleOptionsAction,
  type ScheduleSpec,
} from '@temporalio/client';

export const HANDOVER_DUE_REMINDER_SCHEDULE_ID = 'careos.handover-due-reminder-sweep';
const HANDOVER_DUE_REMINDER_WORKFLOW_TYPE = 'HandoverDueReminderSweepWorkflow';
const HANDOVER_DUE_REMINDER_WORKFLOW_ID = 'handover-due-reminder-sweep';

export interface HandoverDueReminderScheduleOptions {
  readonly taskQueue: string;
  readonly minOverdueMinutes?: number;
  readonly maxOverdueMinutes?: number;
}

export interface HandoverDueReminderScheduleSpec {
  readonly action: ScheduleOptionsAction;
  readonly spec: ScheduleSpec;
}

export function buildHandoverDueReminderSchedule(
  options: HandoverDueReminderScheduleOptions,
): HandoverDueReminderScheduleSpec {
  return {
    action: {
      args: [
        {
          maxOverdueMinutes: options.maxOverdueMinutes ?? 240,
          minOverdueMinutes: options.minOverdueMinutes ?? 15,
        },
      ],
      taskQueue: options.taskQueue,
      type: 'startWorkflow',
      workflowId: HANDOVER_DUE_REMINDER_WORKFLOW_ID,
      workflowType: HANDOVER_DUE_REMINDER_WORKFLOW_TYPE,
    },
    spec: { intervals: [{ every: '10 minutes' }] },
  };
}

export type ScheduleRegistrationOutcome = 'created' | 'updated';

export async function registerHandoverDueReminderSchedule(
  client: Client,
  options: HandoverDueReminderScheduleOptions,
): Promise<ScheduleRegistrationOutcome> {
  const { action, spec } = buildHandoverDueReminderSchedule(options);

  try {
    await client.schedule.create({
      action,
      policies: { overlap: 'SKIP' },
      scheduleId: HANDOVER_DUE_REMINDER_SCHEDULE_ID,
      spec,
    });
    return 'created';
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      const handle = client.schedule.getHandle(HANDOVER_DUE_REMINDER_SCHEDULE_ID);
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
