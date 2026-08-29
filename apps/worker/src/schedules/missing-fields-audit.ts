// Phase 3 §2 (D3 slice 5) — nightly missing-mandatory-fields audit schedule.

import {
  type Client,
  ScheduleAlreadyRunning,
  type ScheduleOptionsAction,
  type ScheduleSpec,
} from '@temporalio/client';

export const MISSING_FIELDS_AUDIT_SCHEDULE_ID = 'careos.missing-fields-audit-sweep';
const MISSING_FIELDS_AUDIT_WORKFLOW_TYPE = 'MissingFieldsAuditSweepWorkflow';
const MISSING_FIELDS_AUDIT_WORKFLOW_ID = 'missing-fields-audit-sweep';

export interface MissingFieldsAuditScheduleOptions {
  readonly taskQueue: string;
  readonly minAgeMinutes?: number;
  readonly intervalMinutes?: number;
}

export interface MissingFieldsAuditScheduleSpec {
  readonly action: ScheduleOptionsAction;
  readonly spec: ScheduleSpec;
}

export function buildMissingFieldsAuditSchedule(
  options: MissingFieldsAuditScheduleOptions,
): MissingFieldsAuditScheduleSpec {
  const interval = options.intervalMinutes ?? 60;
  return {
    action: {
      args: [
        {
          minAgeMinutes: options.minAgeMinutes ?? 1440,
        },
      ],
      taskQueue: options.taskQueue,
      type: 'startWorkflow',
      workflowId: MISSING_FIELDS_AUDIT_WORKFLOW_ID,
      workflowType: MISSING_FIELDS_AUDIT_WORKFLOW_TYPE,
    },
    spec: { intervals: [{ every: `${interval} minutes` }] },
  };
}

export type ScheduleRegistrationOutcome = 'created' | 'updated';

export async function registerMissingFieldsAuditSchedule(
  client: Client,
  options: MissingFieldsAuditScheduleOptions,
): Promise<ScheduleRegistrationOutcome> {
  const { action, spec } = buildMissingFieldsAuditSchedule(options);

  try {
    await client.schedule.create({
      action,
      policies: { overlap: 'SKIP' },
      scheduleId: MISSING_FIELDS_AUDIT_SCHEDULE_ID,
      spec,
    });
    return 'created';
  } catch (error) {
    if (error instanceof ScheduleAlreadyRunning) {
      const handle = client.schedule.getHandle(MISSING_FIELDS_AUDIT_SCHEDULE_ID);
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
