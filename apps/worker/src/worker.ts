import { fileURLToPath } from 'node:url';

import { DEFAULT_APPROVALS_TASK_QUEUE } from '@careos/contracts';
import { NativeConnection, Worker } from '@temporalio/worker';

export { DEFAULT_APPROVALS_TASK_QUEUE } from '@careos/contracts';

import * as approvalActivities from './activities/approvals.js';
import * as documentsExtractActivities from './activities/documents-extract.js';
import * as documentActivities from './activities/documents.js';
import * as emailDraftActivities from './activities/email-drafts.js';
import * as exportBundleActivities from './activities/export-bundles.js';
import * as handoverDueReminderActivities from './activities/handover-due-reminders.js';
import * as handoverActivities from './activities/handovers.js';
import * as hermesActivities from './activities/hermes.js';
import * as incidentFollowUpActivities from './activities/incident-follow-ups.js';
import * as incidentActivities from './activities/incidents.js';
import * as mattermostActivities from './activities/mattermost.js';
import * as missingFieldsAuditActivities from './activities/missing-fields-audit.js';
import * as novuActivities from './activities/novu.js';
import * as retentionActivities from './activities/retention.js';
import * as rotaActivities from './activities/rota.js';
import * as safeguardingDigestActivities from './activities/safeguarding-digest.js';
import * as shiftReminderActivities from './activities/shift-reminders.js';

export const DEFAULT_TEMPORAL_ADDRESS = 'temporal:7233';
export const DEFAULT_TEMPORAL_NAMESPACE = 'default';
export const DEFAULT_TASK_QUEUE = 'careos.phase0';
export const DEFAULT_INCIDENTS_TASK_QUEUE = 'careos.incidents';
export const DEFAULT_HANDOVERS_TASK_QUEUE = 'careos.handovers';
export const DEFAULT_EMAIL_DRAFTS_TASK_QUEUE = 'careos.emails';
export const DEFAULT_ROTA_TASK_QUEUE = 'careos.rota';
export const DEFAULT_NOTIFICATIONS_TASK_QUEUE = 'careos.notifications';
export const DEFAULT_DOCUMENTS_TASK_QUEUE = 'careos.documents';
export const DEFAULT_EXPORT_BUNDLES_TASK_QUEUE = 'careos.export-bundles';
export const DEFAULT_RETENTION_TASK_QUEUE = 'careos.retention';

export interface WorkerRuntimeConfig {
  readonly namespace: string;
  readonly taskQueue: string;
  readonly incidentsTaskQueue: string;
  readonly handoversTaskQueue: string;
  readonly emailDraftsTaskQueue: string;
  readonly approvalsTaskQueue: string;
  readonly rotaTaskQueue: string;
  readonly notificationsTaskQueue: string;
  readonly documentsTaskQueue: string;
  readonly exportBundlesTaskQueue: string;
  readonly retentionTaskQueue: string;
  readonly temporalAddress: string;
  readonly workflowBundlePath: string | null;
  readonly workflowsPath: string;
}

export function getWorkerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  entrypointUrl: string = import.meta.url,
): WorkerRuntimeConfig {
  return {
    approvalsTaskQueue: env.TEMPORAL_APPROVALS_TASK_QUEUE ?? DEFAULT_APPROVALS_TASK_QUEUE,
    handoversTaskQueue: env.TEMPORAL_HANDOVERS_TASK_QUEUE ?? DEFAULT_HANDOVERS_TASK_QUEUE,
    emailDraftsTaskQueue: env.TEMPORAL_EMAIL_DRAFTS_TASK_QUEUE ?? DEFAULT_EMAIL_DRAFTS_TASK_QUEUE,
    incidentsTaskQueue: env.TEMPORAL_INCIDENTS_TASK_QUEUE ?? DEFAULT_INCIDENTS_TASK_QUEUE,
    namespace: env.TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE,
    notificationsTaskQueue:
      env.TEMPORAL_NOTIFICATIONS_TASK_QUEUE ?? DEFAULT_NOTIFICATIONS_TASK_QUEUE,
    documentsTaskQueue: env.TEMPORAL_DOCUMENTS_TASK_QUEUE ?? DEFAULT_DOCUMENTS_TASK_QUEUE,
    exportBundlesTaskQueue:
      env.TEMPORAL_EXPORT_BUNDLES_TASK_QUEUE ?? DEFAULT_EXPORT_BUNDLES_TASK_QUEUE,
    retentionTaskQueue: env.TEMPORAL_RETENTION_TASK_QUEUE ?? DEFAULT_RETENTION_TASK_QUEUE,
    rotaTaskQueue: env.TEMPORAL_ROTA_TASK_QUEUE ?? DEFAULT_ROTA_TASK_QUEUE,
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE,
    temporalAddress: env.TEMPORAL_HOST ?? DEFAULT_TEMPORAL_ADDRESS,
    workflowBundlePath: getWorkflowBundlePath(entrypointUrl),
    workflowsPath: getWorkflowEntryPath(entrypointUrl),
  };
}

export function getWorkflowEntryPath(entrypointUrl: string): string {
  const extension = entrypointUrl.endsWith('.ts') ? 'ts' : 'js';
  return fileURLToPath(new URL(`./workflows/index.${extension}`, entrypointUrl));
}

export function getWorkflowBundlePath(entrypointUrl: string): string | null {
  return entrypointUrl.endsWith('.js')
    ? fileURLToPath(new URL('./workflow-bundle.js', entrypointUrl))
    : null;
}

function workflowCode(
  config: WorkerRuntimeConfig,
): { readonly workflowBundle: { readonly codePath: string } } | { readonly workflowsPath: string } {
  return config.workflowBundlePath === null
    ? { workflowsPath: config.workflowsPath }
    : { workflowBundle: { codePath: config.workflowBundlePath } };
}

async function resolveConnection(
  config: WorkerRuntimeConfig,
  connection: NativeConnection | undefined,
): Promise<NativeConnection> {
  return connection ?? NativeConnection.connect({ address: config.temporalAddress });
}

export async function createTemporalWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: { ...hermesActivities, ...incidentActivities },
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    ...workflowCode(config),
  });
}

export async function createIncidentsWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: { ...incidentActivities, ...incidentFollowUpActivities },
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.incidentsTaskQueue,
    ...workflowCode(config),
  });
}

export async function createHandoversWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: { ...handoverActivities, ...novuActivities },
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.handoversTaskQueue,
    ...workflowCode(config),
  });
}

export async function createEmailDraftsWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: { ...emailDraftActivities, ...hermesActivities, ...approvalActivities },
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.emailDraftsTaskQueue,
    ...workflowCode(config),
  });
}

export async function createApprovalsWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: approvalActivities,
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.approvalsTaskQueue,
    ...workflowCode(config),
  });
}

export async function createRotaWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: { ...rotaActivities, ...hermesActivities },
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.rotaTaskQueue,
    ...workflowCode(config),
  });
}

export async function createNotificationsWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: {
      ...shiftReminderActivities,
      ...handoverDueReminderActivities,
      ...missingFieldsAuditActivities,
      ...safeguardingDigestActivities,
      ...mattermostActivities,
    },
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.notificationsTaskQueue,
    ...workflowCode(config),
  });
}

export async function createDocumentsWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: { ...documentActivities, ...documentsExtractActivities },
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.documentsTaskQueue,
    ...workflowCode(config),
  });
}

export async function createExportBundlesWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: exportBundleActivities,
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.exportBundlesTaskQueue,
    ...workflowCode(config),
  });
}

export async function createRetentionWorker(
  config: WorkerRuntimeConfig,
  connection?: NativeConnection,
): Promise<Worker> {
  const resolvedConnection = await resolveConnection(config, connection);

  return Worker.create({
    activities: retentionActivities,
    connection: resolvedConnection,
    namespace: config.namespace,
    taskQueue: config.retentionTaskQueue,
    ...workflowCode(config),
  });
}
