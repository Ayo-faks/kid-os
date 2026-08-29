import './instrumentation.js';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';

import {
  createDurableRuntime,
  ensureDurableHandoverDueSchedule,
  ensureDurableMissingFieldsSchedule,
  ensureDurableRetentionSchedule,
  ensureDurableSafeguardingDigestSchedule,
  ensureDurableShiftReminderSchedule,
  getDurableRuntimeConfig,
  isolateDurableScheduleRegistration,
  type DurableRuntimeFeatures,
} from './durable/worker.js';
import {
  registerHandoverDueReminderSchedule,
  HANDOVER_DUE_REMINDER_SCHEDULE_ID,
} from './schedules/handover-due-reminder.js';
import {
  registerMissingFieldsAuditSchedule,
  MISSING_FIELDS_AUDIT_SCHEDULE_ID,
} from './schedules/missing-fields-audit.js';
import {
  registerRetentionSweepSchedule,
  RETENTION_SWEEP_SCHEDULE_ID,
} from './schedules/retention-sweep.js';
import {
  registerSafeguardingDigestSchedule,
  SAFEGUARDING_DIGEST_SCHEDULE_ID,
} from './schedules/safeguarding-digest.js';
import {
  registerShiftReminderSchedule,
  SHIFT_REMINDER_SCHEDULE_ID,
} from './schedules/shift-reminder.js';
import { connectToTemporal } from './temporal-readiness.js';
import {
  createApprovalsWorker,
  createDocumentsWorker,
  createEmailDraftsWorker,
  createExportBundlesWorker,
  createHandoversWorker,
  createIncidentsWorker,
  createNotificationsWorker,
  createRetentionWorker,
  createRotaWorker,
  createTemporalWorker,
  getWorkerRuntimeConfig,
  type WorkerRuntimeConfig,
} from './worker.js';
import { startWorkerHealthServer } from './worker-health.js';

async function registerSchedulesIfEnabled(
  config: WorkerRuntimeConfig,
  durableFeatures: DurableRuntimeFeatures,
): Promise<void> {
  if (process.env.AUTO_REGISTER_SCHEDULES === 'false') {
    process.stdout.write('[worker] schedule auto-registration disabled\n');
    return;
  }

  let connection: Connection | undefined;
  try {
    connection = await Connection.connect({ address: config.temporalAddress });
    const client = new Client({ connection, namespace: config.namespace });
    if (!durableFeatures.shiftReminders) {
      const shiftOutcome = await registerShiftReminderSchedule(client, {
        taskQueue: config.notificationsTaskQueue,
      });
      process.stdout.write(
        `[worker] schedule ${shiftOutcome}: ${SHIFT_REMINDER_SCHEDULE_ID} -> ${config.notificationsTaskQueue}\n`,
      );
    } else {
      process.stdout.write(
        `[worker] Temporal schedule skipped: ${SHIFT_REMINDER_SCHEDULE_ID} is owned by Durable Task\n`,
      );
    }
    if (!durableFeatures.handoverDueReminders) {
      const handoverOutcome = await registerHandoverDueReminderSchedule(client, {
        taskQueue: config.notificationsTaskQueue,
      });
      process.stdout.write(
        `[worker] schedule ${handoverOutcome}: ${HANDOVER_DUE_REMINDER_SCHEDULE_ID} -> ${config.notificationsTaskQueue}\n`,
      );
    } else {
      process.stdout.write(
        `[worker] Temporal schedule skipped: ${HANDOVER_DUE_REMINDER_SCHEDULE_ID} is owned by Durable Task\n`,
      );
    }
    if (!durableFeatures.missingFieldsAudit) {
      const missingFieldsOutcome = await registerMissingFieldsAuditSchedule(client, {
        taskQueue: config.notificationsTaskQueue,
      });
      process.stdout.write(
        `[worker] schedule ${missingFieldsOutcome}: ${MISSING_FIELDS_AUDIT_SCHEDULE_ID} -> ${config.notificationsTaskQueue}\n`,
      );
    } else {
      process.stdout.write(
        `[worker] Temporal schedule skipped: ${MISSING_FIELDS_AUDIT_SCHEDULE_ID} is owned by Durable Task\n`,
      );
    }
    if (!durableFeatures.safeguardingDigest) {
      const safeguardingOutcome = await registerSafeguardingDigestSchedule(client, {
        taskQueue: config.notificationsTaskQueue,
      });
      process.stdout.write(
        `[worker] schedule ${safeguardingOutcome}: ${SAFEGUARDING_DIGEST_SCHEDULE_ID} -> ${config.notificationsTaskQueue}\n`,
      );
    } else {
      process.stdout.write(
        `[worker] Temporal schedule skipped: ${SAFEGUARDING_DIGEST_SCHEDULE_ID} is owned by Durable Task\n`,
      );
    }
    if (!durableFeatures.retention) {
      const retentionOutcome = await registerRetentionSweepSchedule(client, {
        taskQueue: config.retentionTaskQueue,
      });
      process.stdout.write(
        `[worker] schedule ${retentionOutcome}: ${RETENTION_SWEEP_SCHEDULE_ID} -> ${config.retentionTaskQueue}\n`,
      );
    } else {
      process.stdout.write(
        `[worker] Temporal schedule skipped: ${RETENTION_SWEEP_SCHEDULE_ID} is owned by Durable Task\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `[worker] schedule auto-registration failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  } finally {
    await connection?.close();
  }
}

async function main(): Promise<void> {
  startWorkerHealthServer();
  const config = getWorkerRuntimeConfig();
  const durableConfig = getDurableRuntimeConfig();
  const temporalConnection = await connectToTemporal({
    address: config.temporalAddress,
    connect: (address) => NativeConnection.connect({ address }),
    delayMs: positiveInteger(process.env.TEMPORAL_CONNECT_RETRY_DELAY_MS, 5_000),
    onRetry: (attempt, error) => {
      if (attempt === 1 || attempt % 12 === 0) {
        process.stderr.write(
          `[worker] Temporal unavailable at ${config.temporalAddress}; attempt=${attempt} error=${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    },
  });
  if (temporalConnection.attempts > 1) {
    process.stdout.write(
      `[worker] Temporal ready after ${temporalConnection.attempts} connection attempts\n`,
    );
  }
  const [
    phase0Worker,
    incidentsWorker,
    handoversWorker,
    emailDraftsWorker,
    approvalsWorker,
    rotaWorker,
    notificationsWorker,
    documentsWorker,
    exportBundlesWorker,
    retentionWorker,
  ] = await Promise.all([
    createTemporalWorker(config, temporalConnection.connection),
    createIncidentsWorker(config, temporalConnection.connection),
    createHandoversWorker(config, temporalConnection.connection),
    createEmailDraftsWorker(config, temporalConnection.connection),
    createApprovalsWorker(config, temporalConnection.connection),
    createRotaWorker(config, temporalConnection.connection),
    createNotificationsWorker(config, temporalConnection.connection),
    createDocumentsWorker(config, temporalConnection.connection),
    createExportBundlesWorker(config, temporalConnection.connection),
    createRetentionWorker(config, temporalConnection.connection),
  ]);

  await registerSchedulesIfEnabled(config, durableConfig.features);

  if (durableConfig.enabled) {
    const durableRuntime = createDurableRuntime(
      durableConfig.connectionString,
      durableConfig.features,
    );
    await durableRuntime.worker.start();
    if (durableConfig.features.shiftReminders && process.env.AUTO_REGISTER_SCHEDULES !== 'false') {
      const outcome = await isolateDurableScheduleRegistration('shift-reminder', () =>
        ensureDurableShiftReminderSchedule(durableRuntime.client),
      );
      process.stdout.write(`[worker] Durable shift-reminder schedule ${outcome}\n`);
    }
    if (durableConfig.features.retention && process.env.AUTO_REGISTER_SCHEDULES !== 'false') {
      const outcome = await isolateDurableScheduleRegistration('retention', () =>
        ensureDurableRetentionSchedule(durableRuntime.client),
      );
      process.stdout.write(`[worker] Durable retention schedule ${outcome}\n`);
    }
    if (
      durableConfig.features.handoverDueReminders &&
      process.env.AUTO_REGISTER_SCHEDULES !== 'false'
    ) {
      const outcome = await isolateDurableScheduleRegistration('handover-due', () =>
        ensureDurableHandoverDueSchedule(durableRuntime.client),
      );
      process.stdout.write(`[worker] Durable handover-due schedule ${outcome}\n`);
    }
    if (
      durableConfig.features.missingFieldsAudit &&
      process.env.AUTO_REGISTER_SCHEDULES !== 'false'
    ) {
      const outcome = await isolateDurableScheduleRegistration('missing-fields', () =>
        ensureDurableMissingFieldsSchedule(durableRuntime.client),
      );
      process.stdout.write(`[worker] Durable missing-fields schedule ${outcome}\n`);
    }
    if (
      durableConfig.features.safeguardingDigest &&
      process.env.AUTO_REGISTER_SCHEDULES !== 'false'
    ) {
      const outcome = await isolateDurableScheduleRegistration('safeguarding-digest', () =>
        ensureDurableSafeguardingDigestSchedule(durableRuntime.client),
      );
      process.stdout.write(`[worker] Durable safeguarding-digest schedule ${outcome}\n`);
    }
    process.stdout.write(
      `[worker] Durable worker started features=${Object.entries(durableConfig.features)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .join(',')}\n`,
    );
  }

  process.stdout.write(
    `[worker] starting Temporal workers on ${config.temporalAddress} namespace=${config.namespace} queues=${config.taskQueue},${config.incidentsTaskQueue},${config.handoversTaskQueue},${config.emailDraftsTaskQueue},${config.approvalsTaskQueue},${config.rotaTaskQueue},${config.notificationsTaskQueue},${config.documentsTaskQueue},${config.exportBundlesTaskQueue},${config.retentionTaskQueue}\n`,
  );

  await Promise.all([
    phase0Worker.run(),
    incidentsWorker.run(),
    handoversWorker.run(),
    emailDraftsWorker.run(),
    approvalsWorker.run(),
    rotaWorker.run(),
    notificationsWorker.run(),
    documentsWorker.run(),
    exportBundlesWorker.run(),
    retentionWorker.run(),
  ]);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

await main();
