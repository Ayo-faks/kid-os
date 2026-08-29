// Phase 3 §2 (D3 wiring) — CLI to register/upsert the shift-reminder
// Temporal schedule. The worker now auto-registers this on boot
// (see `registerSchedulesIfEnabled` in `apps/worker/src/index.ts`); this
// script is retained for ad-hoc reruns after manual schedule deletion.
//
//   pnpm --filter @careos/worker register-shift-reminder-schedule

import { Client, Connection } from '@temporalio/client';

import {
  registerShiftReminderSchedule,
  SHIFT_REMINDER_SCHEDULE_ID,
} from '../schedules/shift-reminder.js';
import {
  DEFAULT_NOTIFICATIONS_TASK_QUEUE,
  DEFAULT_TEMPORAL_ADDRESS,
  DEFAULT_TEMPORAL_NAMESPACE,
} from '../worker.js';

async function main(): Promise<void> {
  const address = process.env.TEMPORAL_HOST ?? DEFAULT_TEMPORAL_ADDRESS;
  const namespace = process.env.TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
  const taskQueue =
    process.env.TEMPORAL_NOTIFICATIONS_TASK_QUEUE ?? DEFAULT_NOTIFICATIONS_TASK_QUEUE;

  const connection = await Connection.connect({ address });
  try {
    const client = new Client({ connection, namespace });
    const outcome = await registerShiftReminderSchedule(client, { taskQueue });
    process.stdout.write(
      `[schedule] ${outcome} ${SHIFT_REMINDER_SCHEDULE_ID} on queue=${taskQueue}\n`,
    );
  } finally {
    await connection.close();
  }
}

await main();
