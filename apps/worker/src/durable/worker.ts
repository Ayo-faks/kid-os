import {
  OrchestrationStatus,
  VersionFailureStrategy,
  VersionMatchStrategy,
  type TaskHubGrpcClient,
  type TaskHubGrpcWorker,
} from '@microsoft/durabletask-js';
import {
  createAzureManagedClient,
  createAzureManagedWorkerBuilder,
} from '@microsoft/durabletask-js-azuremanaged';

import {
  applyApprovalDecisionCommandActivity,
  createApprovalRequestFromReferenceActivity,
} from './activities/approval-routing.activities.js';
import { processDocumentIngestActivity } from './activities/document-ingest.activities.js';
import {
  finalizeEmailDraftFailureActivity,
  processEmailDraftCommandActivity,
} from './activities/email-draft.activities.js';
import { processSeriousIncidentExportActivity } from './activities/export-bundle.activities.js';
import {
  calculateNextHandoverDueFireActivity,
  createStartHandoverDueDeliveryActivity,
  createStartHandoverDueSweepActivity,
  findHandoverDueTargetsActivity,
  processHandoverDueDeliveryActivity,
} from './activities/handover-due-reminder.activities.js';
import {
  finalizeHandoverFailureActivity,
  processHandoverCommandActivity,
} from './activities/handover.activities.js';
import {
  createStartIncidentFollowUpActionActivity,
  createStartApprovalActivity,
  finalizeIncidentFollowUpActionActivity,
  processIncidentFollowUpActionActivity,
} from './activities/incident-follow-up.activities.js';
import {
  applyIncidentCommandActivity,
  initializeIncidentFromCommandActivity,
  recordIncidentApprovalResultActivity,
} from './activities/incident-report.activities.js';
import {
  calculateNextMissingFieldsFireActivity,
  createStartMissingFieldsDeliveryActivity,
  createStartMissingFieldsSweepActivity,
  findMissingFieldsTargetsActivity,
  processMissingFieldsDeliveryActivity,
} from './activities/missing-fields-audit.activities.js';
import {
  finalizePingFailureActivity,
  processPingCommandActivity,
} from './activities/ping.activities.js';
import {
  calculateNextRetentionFireActivity,
  createStartRetentionSweepActivity,
  finalizeRetentionSweepFailureActivity,
  processRetentionSweepActivity,
} from './activities/retention.activities.js';
import {
  finalizeRotaAnalyzeFailureActivity,
  processRotaAnalyzeCommandActivity,
} from './activities/rota-analyze.activities.js';
import {
  finalizeRotaPublishFailureActivity,
  processRotaPublishCommandActivity,
} from './activities/rota-publish.activities.js';
import {
  calculateNextSafeguardingDigestFireActivity,
  createStartSafeguardingDigestDeliveryActivity,
  createStartSafeguardingDigestSweepActivity,
  findSafeguardingDigestTargetsActivity,
  processSafeguardingDigestDeliveryActivity,
} from './activities/safeguarding-digest.activities.js';
import {
  calculateNextShiftReminderFireActivity,
  createStartShiftReminderDeliveryActivity,
  createStartShiftReminderSweepActivity,
  findUpcomingShiftsActivity,
  loadShiftReminderContextActivity,
  markShiftReminderSentActivity,
  postMattermostMessageActivity,
  processShiftReminderDeliveryActivity,
} from './activities/shift-reminder.activities.js';
import {
  APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY,
  APPROVAL_ORCHESTRATION_VERSION,
  APPROVAL_ROUTING_ORCHESTRATOR,
  CREATE_APPROVAL_REQUEST_ACTIVITY,
} from './approval-routing.contracts.js';
import {
  DOCUMENT_INGEST_ORCHESTRATOR,
  PROCESS_DOCUMENT_INGEST_ACTIVITY,
} from './document-ingest.contracts.js';
import {
  EMAIL_DRAFT_ORCHESTRATOR,
  FINALIZE_EMAIL_DRAFT_FAILURE_ACTIVITY,
  PROCESS_EMAIL_DRAFT_COMMAND_ACTIVITY,
  START_EMAIL_DRAFT_APPROVAL_ACTIVITY,
} from './email-draft.contracts.js';
import {
  PROCESS_EXPORT_BUNDLE_ACTIVITY,
  SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR,
} from './export-bundle.contracts.js';
import {
  CALCULATE_NEXT_HANDOVER_DUE_FIRE_ACTIVITY,
  FIND_HANDOVER_DUE_TARGETS_ACTIVITY,
  HANDOVER_DUE_ORCHESTRATION_VERSION,
  HANDOVER_DUE_SCHEDULE_ORCHESTRATOR,
  HANDOVER_DUE_SWEEP_ORCHESTRATOR,
  PROCESS_HANDOVER_DUE_DELIVERY_ACTIVITY,
  SEND_HANDOVER_DUE_ORCHESTRATOR,
  START_HANDOVER_DUE_DELIVERY_ACTIVITY,
  START_HANDOVER_DUE_SWEEP_ACTIVITY,
} from './handover-due-reminder.contracts.js';
import {
  FINALIZE_HANDOVER_FAILURE_ACTIVITY,
  HANDOVER_ORCHESTRATOR,
  PROCESS_HANDOVER_COMMAND_ACTIVITY,
} from './handover.contracts.js';
import {
  FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY,
  INCIDENT_FOLLOW_UP_ORCHESTRATOR,
  PROCESS_INCIDENT_FOLLOW_UP_ACTIVITY,
  START_FOLLOW_UP_APPROVAL_ACTIVITY,
  START_INCIDENT_FOLLOW_UP_ACTIVITY,
} from './incident-follow-up.contracts.js';
import {
  APPLY_INCIDENT_COMMAND_ACTIVITY,
  INCIDENT_REPORT_ORCHESTRATOR,
  INITIALIZE_INCIDENT_ACTIVITY,
  RECORD_INCIDENT_APPROVAL_ACTIVITY,
} from './incident-report.contracts.js';
import {
  CALCULATE_NEXT_MISSING_FIELDS_FIRE_ACTIVITY,
  FIND_MISSING_FIELDS_TARGETS_ACTIVITY,
  MISSING_FIELDS_ORCHESTRATION_VERSION,
  MISSING_FIELDS_SCHEDULE_ORCHESTRATOR,
  MISSING_FIELDS_SWEEP_ORCHESTRATOR,
  PROCESS_MISSING_FIELDS_DELIVERY_ACTIVITY,
  SEND_MISSING_FIELDS_ORCHESTRATOR,
  START_MISSING_FIELDS_DELIVERY_ACTIVITY,
  START_MISSING_FIELDS_SWEEP_ACTIVITY,
} from './missing-fields-audit.contracts.js';
import type { DurableOrchestrationStarter } from './orchestration-starter.js';
import { ApprovalRoutingOrchestrator } from './orchestrators/approval-routing.orchestrator.js';
import { DocumentIngestOrchestrator } from './orchestrators/document-ingest.orchestrator.js';
import { EmailDraftOrchestrator } from './orchestrators/email-draft.orchestrator.js';
import { SeriousIncidentExportOrchestrator } from './orchestrators/export-bundle.orchestrator.js';
import {
  HandoverDueScheduleOrchestrator,
  HandoverDueSweepOrchestrator,
  SendHandoverDueOrchestrator,
} from './orchestrators/handover-due-reminder.orchestrators.js';
import { HandoverOrchestrator } from './orchestrators/handover.orchestrator.js';
import { IncidentFollowUpActionOrchestrator } from './orchestrators/incident-follow-up.orchestrator.js';
import { IncidentReportOrchestrator } from './orchestrators/incident-report.orchestrator.js';
import {
  MissingFieldsScheduleOrchestrator,
  MissingFieldsSweepOrchestrator,
  SendMissingFieldsOrchestrator,
} from './orchestrators/missing-fields-audit.orchestrators.js';
import { PingOrchestrator } from './orchestrators/ping.orchestrator.js';
import {
  RetentionScheduleOrchestrator,
  RetentionSweepOrchestrator,
} from './orchestrators/retention.orchestrators.js';
import { RotaAnalyzeOrchestrator } from './orchestrators/rota-analyze.orchestrator.js';
import { RotaPublishOrchestrator } from './orchestrators/rota-publish.orchestrator.js';
import {
  SafeguardingDigestScheduleOrchestrator,
  SafeguardingDigestSweepOrchestrator,
  SendSafeguardingDigestOrchestrator,
} from './orchestrators/safeguarding-digest.orchestrators.js';
import {
  SendShiftReminderOrchestrator,
  ShiftReminderScheduleOrchestrator,
  ShiftReminderSweepOrchestrator,
} from './orchestrators/shift-reminder.orchestrators.js';
import { assertDurableInstanceId } from './payload-policy.js';
import {
  FINALIZE_PING_FAILURE_ACTIVITY,
  PING_ORCHESTRATOR,
  PROCESS_PING_COMMAND_ACTIVITY,
} from './ping.contracts.js';
import {
  CALCULATE_NEXT_RETENTION_FIRE_ACTIVITY,
  FINALIZE_RETENTION_SWEEP_FAILURE_ACTIVITY,
  PROCESS_RETENTION_SWEEP_ACTIVITY,
  RETENTION_ORCHESTRATION_VERSION,
  RETENTION_SCHEDULE_ORCHESTRATOR,
  RETENTION_SWEEP_ORCHESTRATOR,
  START_RETENTION_SWEEP_ACTIVITY,
} from './retention.contracts.js';
import {
  FINALIZE_ROTA_ANALYZE_FAILURE_ACTIVITY,
  PROCESS_ROTA_ANALYZE_COMMAND_ACTIVITY,
  ROTA_ANALYZE_ORCHESTRATOR,
} from './rota-analyze.contracts.js';
import {
  FINALIZE_ROTA_PUBLISH_FAILURE_ACTIVITY,
  PROCESS_ROTA_PUBLISH_COMMAND_ACTIVITY,
  ROTA_PUBLISH_ORCHESTRATOR,
} from './rota-publish.contracts.js';
import {
  CALCULATE_NEXT_SAFEGUARDING_DIGEST_FIRE_ACTIVITY,
  FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY,
  PROCESS_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
  SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
  SAFEGUARDING_DIGEST_SCHEDULE_ORCHESTRATOR,
  SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
  SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR,
  START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
  START_SAFEGUARDING_DIGEST_SWEEP_ACTIVITY,
} from './safeguarding-digest.contracts.js';
import {
  CALCULATE_NEXT_SHIFT_REMINDER_FIRE_ACTIVITY,
  FIND_UPCOMING_SHIFTS_ACTIVITY,
  LOAD_SHIFT_REMINDER_CONTEXT_ACTIVITY,
  MARK_SHIFT_REMINDER_SENT_ACTIVITY,
  POST_MATTERMOST_MESSAGE_ACTIVITY,
  PROCESS_SHIFT_REMINDER_DELIVERY_ACTIVITY,
  SEND_SHIFT_REMINDER_ORCHESTRATOR,
  SHIFT_REMINDER_ORCHESTRATION_VERSION,
  SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR,
  SHIFT_REMINDER_SWEEP_ORCHESTRATOR,
  START_SHIFT_REMINDER_DELIVERY_ACTIVITY,
  START_SHIFT_REMINDER_SWEEP_ACTIVITY,
} from './shift-reminder.contracts.js';

export const SHIFT_REMINDER_SCHEDULE_INSTANCE_ID = 'careos-shift-reminder-schedule-v2';
export const RETENTION_SCHEDULE_INSTANCE_ID = 'careos-retention-schedule-v1';
export const HANDOVER_DUE_SCHEDULE_INSTANCE_ID = 'careos-handover-due-schedule-v1';
export const MISSING_FIELDS_SCHEDULE_INSTANCE_ID = 'careos-missing-fields-schedule-v1';
export const SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID = 'careos-safeguarding-digest-schedule-v1';

export type DurableShiftReminderRuntimeConfig =
  | { readonly enabled: false }
  | { readonly connectionString: string; readonly enabled: true };

export interface DurableShiftReminderRuntime {
  readonly client: TaskHubGrpcClient;
  readonly worker: TaskHubGrpcWorker;
}

export interface DurableRuntimeFeatures {
  readonly approvals: boolean;
  readonly documents: boolean;
  readonly emailDrafts: boolean;
  readonly exportBundles: boolean;
  readonly handoverDueReminders: boolean;
  readonly handovers: boolean;
  readonly incidents: boolean;
  readonly missingFieldsAudit: boolean;
  readonly ping: boolean;
  readonly retention: boolean;
  readonly rotaAnalyze: boolean;
  readonly rotaPublish: boolean;
  readonly safeguardingDigest: boolean;
  readonly shiftReminders: boolean;
}

export type DurableRuntimeConfig =
  | { readonly enabled: false; readonly features: DurableRuntimeFeatures }
  | {
      readonly connectionString: string;
      readonly enabled: true;
      readonly features: DurableRuntimeFeatures;
    };

type DurableShiftReminderScheduleClient = DurableOrchestrationStarter;

export function getDurableShiftReminderRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): DurableShiftReminderRuntimeConfig {
  const runtime = env.WORKFLOW_RUNTIME_SHIFT_REMINDERS ?? 'temporal';
  if (runtime === 'temporal') return { enabled: false };
  if (runtime !== 'durable') {
    throw new Error('WORKFLOW_RUNTIME_SHIFT_REMINDERS must be "temporal" or "durable".');
  }
  const connectionString = env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING?.trim();
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'DURABLE_TASK_SCHEDULER_CONNECTION_STRING is required when shift reminders use Durable Task.',
    );
  }
  return { connectionString, enabled: true };
}

export function getDurableRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): DurableRuntimeConfig {
  const features = {
    approvals: durableFeatureEnabled(env.WORKFLOW_RUNTIME_APPROVALS, 'WORKFLOW_RUNTIME_APPROVALS'),
    documents: durableFeatureEnabled(env.WORKFLOW_RUNTIME_DOCUMENTS, 'WORKFLOW_RUNTIME_DOCUMENTS'),
    emailDrafts: durableFeatureEnabled(
      env.WORKFLOW_RUNTIME_EMAIL_DRAFTS,
      'WORKFLOW_RUNTIME_EMAIL_DRAFTS',
    ),
    exportBundles: durableFeatureEnabled(
      env.WORKFLOW_RUNTIME_EXPORT_BUNDLES,
      'WORKFLOW_RUNTIME_EXPORT_BUNDLES',
    ),
    handoverDueReminders: durableFeatureEnabled(
      env.WORKFLOW_RUNTIME_HANDOVER_DUE_REMINDERS,
      'WORKFLOW_RUNTIME_HANDOVER_DUE_REMINDERS',
    ),
    handovers: durableFeatureEnabled(env.WORKFLOW_RUNTIME_HANDOVERS, 'WORKFLOW_RUNTIME_HANDOVERS'),
    incidents: durableFeatureEnabled(env.WORKFLOW_RUNTIME_INCIDENTS, 'WORKFLOW_RUNTIME_INCIDENTS'),
    missingFieldsAudit: durableFeatureEnabled(
      env.WORKFLOW_RUNTIME_MISSING_FIELDS_AUDIT,
      'WORKFLOW_RUNTIME_MISSING_FIELDS_AUDIT',
    ),
    ping: durableFeatureEnabled(env.WORKFLOW_RUNTIME_PING, 'WORKFLOW_RUNTIME_PING'),
    retention: durableFeatureEnabled(env.WORKFLOW_RUNTIME_RETENTION, 'WORKFLOW_RUNTIME_RETENTION'),
    rotaAnalyze: durableFeatureEnabled(
      env.WORKFLOW_RUNTIME_ROTA_ANALYZE,
      'WORKFLOW_RUNTIME_ROTA_ANALYZE',
    ),
    rotaPublish: durableFeatureEnabled(
      env.WORKFLOW_RUNTIME_ROTA_PUBLISH,
      'WORKFLOW_RUNTIME_ROTA_PUBLISH',
    ),
    safeguardingDigest: durableFeatureEnabled(
      env.WORKFLOW_RUNTIME_SAFEGUARDING_DIGEST,
      'WORKFLOW_RUNTIME_SAFEGUARDING_DIGEST',
    ),
    shiftReminders: durableFeatureEnabled(
      env.WORKFLOW_RUNTIME_SHIFT_REMINDERS,
      'WORKFLOW_RUNTIME_SHIFT_REMINDERS',
    ),
  };
  if (features.incidents && !features.approvals) {
    throw new Error(
      'WORKFLOW_RUNTIME_APPROVALS must be "durable" when incidents use Durable Task.',
    );
  }
  if (features.emailDrafts && !features.approvals) {
    throw new Error(
      'WORKFLOW_RUNTIME_APPROVALS must be "durable" when email drafts use Durable Task.',
    );
  }
  if (
    !features.approvals &&
    !features.documents &&
    !features.emailDrafts &&
    !features.exportBundles &&
    !features.handoverDueReminders &&
    !features.handovers &&
    !features.incidents &&
    !features.missingFieldsAudit &&
    !features.ping &&
    !features.retention &&
    !features.rotaAnalyze &&
    !features.rotaPublish &&
    !features.safeguardingDigest &&
    !features.shiftReminders
  ) {
    return { enabled: false, features };
  }
  const connectionString = env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING?.trim();
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'DURABLE_TASK_SCHEDULER_CONNECTION_STRING is required when a workflow uses Durable Task.',
    );
  }
  return { connectionString, enabled: true, features };
}

export function createDurableShiftReminderRuntime(
  connectionString: string,
): DurableShiftReminderRuntime {
  return createDurableRuntime(connectionString, {
    approvals: false,
    documents: false,
    emailDrafts: false,
    exportBundles: false,
    handoverDueReminders: false,
    handovers: false,
    incidents: false,
    missingFieldsAudit: false,
    ping: false,
    retention: false,
    rotaAnalyze: false,
    rotaPublish: false,
    safeguardingDigest: false,
    shiftReminders: true,
  });
}

export function createDurableRuntime(
  connectionString: string,
  features: DurableRuntimeFeatures,
): DurableShiftReminderRuntime {
  const client = createAzureManagedClient(connectionString);
  const starter = orchestrationStarter(client);
  const builder = createAzureManagedWorkerBuilder(connectionString).versioning({
    defaultVersion: APPROVAL_ORCHESTRATION_VERSION,
    failureStrategy: VersionFailureStrategy.Reject,
    matchStrategy: VersionMatchStrategy.Strict,
    version: APPROVAL_ORCHESTRATION_VERSION,
  });

  if (features.approvals) {
    builder
      .addNamedOrchestrator(APPROVAL_ROUTING_ORCHESTRATOR, ApprovalRoutingOrchestrator)
      .addNamedActivity(
        CREATE_APPROVAL_REQUEST_ACTIVITY,
        createApprovalRequestFromReferenceActivity,
      )
      .addNamedActivity(
        APPLY_APPROVAL_DECISION_COMMAND_ACTIVITY,
        applyApprovalDecisionCommandActivity,
      );
  }

  if (features.documents) {
    builder
      .addNamedOrchestrator(DOCUMENT_INGEST_ORCHESTRATOR, DocumentIngestOrchestrator)
      .addNamedActivity(PROCESS_DOCUMENT_INGEST_ACTIVITY, processDocumentIngestActivity);
  }

  if (features.emailDrafts) {
    builder
      .addNamedOrchestrator(EMAIL_DRAFT_ORCHESTRATOR, EmailDraftOrchestrator)
      .addNamedActivity(PROCESS_EMAIL_DRAFT_COMMAND_ACTIVITY, processEmailDraftCommandActivity)
      .addNamedActivity(FINALIZE_EMAIL_DRAFT_FAILURE_ACTIVITY, finalizeEmailDraftFailureActivity)
      .addNamedActivity(START_EMAIL_DRAFT_APPROVAL_ACTIVITY, createStartApprovalActivity(starter));
  }

  if (features.exportBundles) {
    builder
      .addNamedOrchestrator(SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR, SeriousIncidentExportOrchestrator)
      .addNamedActivity(PROCESS_EXPORT_BUNDLE_ACTIVITY, processSeriousIncidentExportActivity);
  }

  if (features.handovers) {
    builder
      .addNamedOrchestrator(HANDOVER_ORCHESTRATOR, HandoverOrchestrator)
      .addNamedActivity(PROCESS_HANDOVER_COMMAND_ACTIVITY, processHandoverCommandActivity)
      .addNamedActivity(FINALIZE_HANDOVER_FAILURE_ACTIVITY, finalizeHandoverFailureActivity);
  }

  if (features.handoverDueReminders) {
    builder
      .addNamedOrchestrator(HANDOVER_DUE_SCHEDULE_ORCHESTRATOR, HandoverDueScheduleOrchestrator)
      .addNamedOrchestrator(HANDOVER_DUE_SWEEP_ORCHESTRATOR, HandoverDueSweepOrchestrator)
      .addNamedOrchestrator(SEND_HANDOVER_DUE_ORCHESTRATOR, SendHandoverDueOrchestrator)
      .addNamedActivity(
        CALCULATE_NEXT_HANDOVER_DUE_FIRE_ACTIVITY,
        calculateNextHandoverDueFireActivity,
      )
      .addNamedActivity(FIND_HANDOVER_DUE_TARGETS_ACTIVITY, findHandoverDueTargetsActivity)
      .addNamedActivity(PROCESS_HANDOVER_DUE_DELIVERY_ACTIVITY, processHandoverDueDeliveryActivity)
      .addNamedActivity(
        START_HANDOVER_DUE_SWEEP_ACTIVITY,
        createStartHandoverDueSweepActivity(starter),
      )
      .addNamedActivity(
        START_HANDOVER_DUE_DELIVERY_ACTIVITY,
        createStartHandoverDueDeliveryActivity(starter),
      );
  }

  if (features.rotaAnalyze) {
    builder
      .addNamedOrchestrator(ROTA_ANALYZE_ORCHESTRATOR, RotaAnalyzeOrchestrator)
      .addNamedActivity(PROCESS_ROTA_ANALYZE_COMMAND_ACTIVITY, processRotaAnalyzeCommandActivity)
      .addNamedActivity(FINALIZE_ROTA_ANALYZE_FAILURE_ACTIVITY, finalizeRotaAnalyzeFailureActivity);
  }

  if (features.retention) {
    builder
      .addNamedOrchestrator(RETENTION_SWEEP_ORCHESTRATOR, RetentionSweepOrchestrator)
      .addNamedOrchestrator(RETENTION_SCHEDULE_ORCHESTRATOR, RetentionScheduleOrchestrator)
      .addNamedActivity(PROCESS_RETENTION_SWEEP_ACTIVITY, processRetentionSweepActivity)
      .addNamedActivity(
        FINALIZE_RETENTION_SWEEP_FAILURE_ACTIVITY,
        finalizeRetentionSweepFailureActivity,
      )
      .addNamedActivity(CALCULATE_NEXT_RETENTION_FIRE_ACTIVITY, calculateNextRetentionFireActivity)
      .addNamedActivity(START_RETENTION_SWEEP_ACTIVITY, createStartRetentionSweepActivity(starter));
  }

  if (features.safeguardingDigest) {
    builder
      .addNamedOrchestrator(
        SAFEGUARDING_DIGEST_SCHEDULE_ORCHESTRATOR,
        SafeguardingDigestScheduleOrchestrator,
      )
      .addNamedOrchestrator(
        SAFEGUARDING_DIGEST_SWEEP_ORCHESTRATOR,
        SafeguardingDigestSweepOrchestrator,
      )
      .addNamedOrchestrator(
        SEND_SAFEGUARDING_DIGEST_ORCHESTRATOR,
        SendSafeguardingDigestOrchestrator,
      )
      .addNamedActivity(
        CALCULATE_NEXT_SAFEGUARDING_DIGEST_FIRE_ACTIVITY,
        calculateNextSafeguardingDigestFireActivity,
      )
      .addNamedActivity(
        FIND_SAFEGUARDING_DIGEST_TARGETS_ACTIVITY,
        findSafeguardingDigestTargetsActivity,
      )
      .addNamedActivity(
        PROCESS_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
        processSafeguardingDigestDeliveryActivity,
      )
      .addNamedActivity(
        START_SAFEGUARDING_DIGEST_SWEEP_ACTIVITY,
        createStartSafeguardingDigestSweepActivity(starter),
      )
      .addNamedActivity(
        START_SAFEGUARDING_DIGEST_DELIVERY_ACTIVITY,
        createStartSafeguardingDigestDeliveryActivity(starter),
      );
  }

  if (features.rotaPublish) {
    builder
      .addNamedOrchestrator(ROTA_PUBLISH_ORCHESTRATOR, RotaPublishOrchestrator)
      .addNamedActivity(PROCESS_ROTA_PUBLISH_COMMAND_ACTIVITY, processRotaPublishCommandActivity)
      .addNamedActivity(FINALIZE_ROTA_PUBLISH_FAILURE_ACTIVITY, finalizeRotaPublishFailureActivity);
  }

  if (features.incidents) {
    builder
      .addNamedOrchestrator(INCIDENT_REPORT_ORCHESTRATOR, IncidentReportOrchestrator)
      .addNamedOrchestrator(INCIDENT_FOLLOW_UP_ORCHESTRATOR, IncidentFollowUpActionOrchestrator)
      .addNamedActivity(INITIALIZE_INCIDENT_ACTIVITY, initializeIncidentFromCommandActivity)
      .addNamedActivity(APPLY_INCIDENT_COMMAND_ACTIVITY, applyIncidentCommandActivity)
      .addNamedActivity(RECORD_INCIDENT_APPROVAL_ACTIVITY, recordIncidentApprovalResultActivity)
      .addNamedActivity(PROCESS_INCIDENT_FOLLOW_UP_ACTIVITY, processIncidentFollowUpActionActivity)
      .addNamedActivity(
        FINALIZE_INCIDENT_FOLLOW_UP_ACTIVITY,
        finalizeIncidentFollowUpActionActivity,
      )
      .addNamedActivity(
        START_INCIDENT_FOLLOW_UP_ACTIVITY,
        createStartIncidentFollowUpActionActivity(starter),
      )
      .addNamedActivity(START_FOLLOW_UP_APPROVAL_ACTIVITY, createStartApprovalActivity(starter));
  }

  if (features.missingFieldsAudit) {
    builder
      .addNamedOrchestrator(MISSING_FIELDS_SCHEDULE_ORCHESTRATOR, MissingFieldsScheduleOrchestrator)
      .addNamedOrchestrator(MISSING_FIELDS_SWEEP_ORCHESTRATOR, MissingFieldsSweepOrchestrator)
      .addNamedOrchestrator(SEND_MISSING_FIELDS_ORCHESTRATOR, SendMissingFieldsOrchestrator)
      .addNamedActivity(
        CALCULATE_NEXT_MISSING_FIELDS_FIRE_ACTIVITY,
        calculateNextMissingFieldsFireActivity,
      )
      .addNamedActivity(FIND_MISSING_FIELDS_TARGETS_ACTIVITY, findMissingFieldsTargetsActivity)
      .addNamedActivity(
        PROCESS_MISSING_FIELDS_DELIVERY_ACTIVITY,
        processMissingFieldsDeliveryActivity,
      )
      .addNamedActivity(
        START_MISSING_FIELDS_SWEEP_ACTIVITY,
        createStartMissingFieldsSweepActivity(starter),
      )
      .addNamedActivity(
        START_MISSING_FIELDS_DELIVERY_ACTIVITY,
        createStartMissingFieldsDeliveryActivity(starter),
      );
  }

  if (features.ping) {
    builder
      .addNamedOrchestrator(PING_ORCHESTRATOR, PingOrchestrator)
      .addNamedActivity(PROCESS_PING_COMMAND_ACTIVITY, processPingCommandActivity)
      .addNamedActivity(FINALIZE_PING_FAILURE_ACTIVITY, finalizePingFailureActivity);
  }

  if (features.shiftReminders) {
    builder
      .addNamedOrchestrator(SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR, ShiftReminderScheduleOrchestrator)
      .addNamedOrchestrator(SHIFT_REMINDER_SWEEP_ORCHESTRATOR, ShiftReminderSweepOrchestrator)
      .addNamedOrchestrator(SEND_SHIFT_REMINDER_ORCHESTRATOR, SendShiftReminderOrchestrator)
      .addNamedActivity(
        CALCULATE_NEXT_SHIFT_REMINDER_FIRE_ACTIVITY,
        calculateNextShiftReminderFireActivity,
      )
      .addNamedActivity(FIND_UPCOMING_SHIFTS_ACTIVITY, findUpcomingShiftsActivity)
      .addNamedActivity(LOAD_SHIFT_REMINDER_CONTEXT_ACTIVITY, loadShiftReminderContextActivity)
      .addNamedActivity(POST_MATTERMOST_MESSAGE_ACTIVITY, postMattermostMessageActivity)
      .addNamedActivity(MARK_SHIFT_REMINDER_SENT_ACTIVITY, markShiftReminderSentActivity)
      .addNamedActivity(
        PROCESS_SHIFT_REMINDER_DELIVERY_ACTIVITY,
        processShiftReminderDeliveryActivity,
      )
      .addNamedActivity(
        START_SHIFT_REMINDER_SWEEP_ACTIVITY,
        createStartShiftReminderSweepActivity(starter),
      )
      .addNamedActivity(
        START_SHIFT_REMINDER_DELIVERY_ACTIVITY,
        createStartShiftReminderDeliveryActivity(starter),
      );
  }

  return { client, worker: builder.build() };
}

function durableFeatureEnabled(value: string | undefined, name: string): boolean {
  const runtime = value ?? 'temporal';
  if (runtime === 'temporal') return false;
  if (runtime === 'durable') return true;
  throw new Error(`${name} must be "temporal" or "durable".`);
}

export type ShiftReminderScheduleStartOutcome = 'created' | 'existing';

export async function isolateDurableScheduleRegistration(
  scheduleName: string,
  register: () => Promise<ShiftReminderScheduleStartOutcome>,
  reportError: (message: string) => void = (message) => process.stderr.write(message),
): Promise<ShiftReminderScheduleStartOutcome | 'degraded'> {
  try {
    return await register();
  } catch (error) {
    reportError(
      `[worker] Durable ${scheduleName} schedule degraded: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 'degraded';
  }
}

export async function ensureDurableShiftReminderSchedule(
  client: DurableShiftReminderScheduleClient,
): Promise<ShiftReminderScheduleStartOutcome> {
  assertDurableInstanceId(SHIFT_REMINDER_SCHEDULE_INSTANCE_ID);
  const existing = await client.getOrchestrationState(SHIFT_REMINDER_SCHEDULE_INSTANCE_ID, false);
  if (existing !== undefined) {
    if (isNonTerminal(existing.runtimeStatus)) return 'existing';
    throw new Error(
      `Durable shift-reminder schedule instance is terminal (${OrchestrationStatus[existing.runtimeStatus]}). ` +
        'Deploy a new versioned singleton ID instead of reusing its history.',
    );
  }

  try {
    await client.scheduleNewOrchestration(
      SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: SHIFT_REMINDER_SCHEDULE_INSTANCE_ID,
        version: SHIFT_REMINDER_ORCHESTRATION_VERSION,
      },
    );
    return 'created';
  } catch (startError) {
    try {
      const raced = await client.getOrchestrationState(SHIFT_REMINDER_SCHEDULE_INSTANCE_ID, false);
      if (raced !== undefined && isNonTerminal(raced.runtimeStatus)) return 'existing';
    } catch {
      // Preserve the original start error if reconciliation is unavailable.
    }
    throw startError;
  }
}

export async function ensureDurableRetentionSchedule(
  client: DurableShiftReminderScheduleClient,
): Promise<ShiftReminderScheduleStartOutcome> {
  assertDurableInstanceId(RETENTION_SCHEDULE_INSTANCE_ID);
  const existing = await client.getOrchestrationState(RETENTION_SCHEDULE_INSTANCE_ID, false);
  if (existing !== undefined) {
    if (isNonTerminal(existing.runtimeStatus)) return 'existing';
    throw new Error(
      `Durable retention schedule instance is terminal (${OrchestrationStatus[existing.runtimeStatus]}). ` +
        'Deploy a new versioned singleton ID instead of reusing its history.',
    );
  }

  try {
    await client.scheduleNewOrchestration(
      RETENTION_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: RETENTION_SCHEDULE_INSTANCE_ID,
        version: RETENTION_ORCHESTRATION_VERSION,
      },
    );
    return 'created';
  } catch (startError) {
    try {
      const raced = await client.getOrchestrationState(RETENTION_SCHEDULE_INSTANCE_ID, false);
      if (raced !== undefined && isNonTerminal(raced.runtimeStatus)) return 'existing';
    } catch {
      // Preserve the original start error if reconciliation is unavailable.
    }
    throw startError;
  }
}

export async function ensureDurableHandoverDueSchedule(
  client: DurableShiftReminderScheduleClient,
): Promise<ShiftReminderScheduleStartOutcome> {
  assertDurableInstanceId(HANDOVER_DUE_SCHEDULE_INSTANCE_ID);
  const existing = await client.getOrchestrationState(HANDOVER_DUE_SCHEDULE_INSTANCE_ID, false);
  if (existing !== undefined) {
    if (isNonTerminal(existing.runtimeStatus)) return 'existing';
    throw new Error(
      `Durable handover-due schedule instance is terminal (${OrchestrationStatus[existing.runtimeStatus]}). ` +
        'Deploy a new versioned singleton ID instead of reusing its history.',
    );
  }

  try {
    await client.scheduleNewOrchestration(
      HANDOVER_DUE_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: HANDOVER_DUE_SCHEDULE_INSTANCE_ID,
        version: HANDOVER_DUE_ORCHESTRATION_VERSION,
      },
    );
    return 'created';
  } catch (startError) {
    try {
      const raced = await client.getOrchestrationState(HANDOVER_DUE_SCHEDULE_INSTANCE_ID, false);
      if (raced !== undefined && isNonTerminal(raced.runtimeStatus)) return 'existing';
    } catch {
      // Preserve the original start error if reconciliation is unavailable.
    }
    throw startError;
  }
}

export async function ensureDurableMissingFieldsSchedule(
  client: DurableShiftReminderScheduleClient,
): Promise<ShiftReminderScheduleStartOutcome> {
  assertDurableInstanceId(MISSING_FIELDS_SCHEDULE_INSTANCE_ID);
  const existing = await client.getOrchestrationState(MISSING_FIELDS_SCHEDULE_INSTANCE_ID, false);
  if (existing !== undefined) {
    if (isNonTerminal(existing.runtimeStatus)) return 'existing';
    throw new Error(
      `Durable missing-fields schedule instance is terminal (${OrchestrationStatus[existing.runtimeStatus]}). ` +
        'Deploy a new versioned singleton ID instead of reusing its history.',
    );
  }

  try {
    await client.scheduleNewOrchestration(
      MISSING_FIELDS_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: MISSING_FIELDS_SCHEDULE_INSTANCE_ID,
        version: MISSING_FIELDS_ORCHESTRATION_VERSION,
      },
    );
    return 'created';
  } catch (startError) {
    try {
      const raced = await client.getOrchestrationState(MISSING_FIELDS_SCHEDULE_INSTANCE_ID, false);
      if (raced !== undefined && isNonTerminal(raced.runtimeStatus)) return 'existing';
    } catch {
      // Preserve the original start error if reconciliation is unavailable.
    }
    throw startError;
  }
}

export async function ensureDurableSafeguardingDigestSchedule(
  client: DurableShiftReminderScheduleClient,
): Promise<ShiftReminderScheduleStartOutcome> {
  assertDurableInstanceId(SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID);
  const existing = await client.getOrchestrationState(
    SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID,
    false,
  );
  if (existing !== undefined) {
    if (isNonTerminal(existing.runtimeStatus)) return 'existing';
    throw new Error(
      `Durable safeguarding-digest schedule instance is terminal (${OrchestrationStatus[existing.runtimeStatus]}). ` +
        'Deploy a new versioned singleton ID instead of reusing its history.',
    );
  }

  try {
    await client.scheduleNewOrchestration(
      SAFEGUARDING_DIGEST_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID,
        version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
      },
    );
    return 'created';
  } catch (startError) {
    try {
      const raced = await client.getOrchestrationState(
        SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID,
        false,
      );
      if (raced !== undefined && isNonTerminal(raced.runtimeStatus)) return 'existing';
    } catch {
      // Preserve the original start error if reconciliation is unavailable.
    }
    throw startError;
  }
}

function isNonTerminal(status: OrchestrationStatus): boolean {
  return [
    OrchestrationStatus.PENDING,
    OrchestrationStatus.RUNNING,
    OrchestrationStatus.SUSPENDED,
    OrchestrationStatus.CONTINUED_AS_NEW,
  ].includes(status);
}

function orchestrationStarter(client: TaskHubGrpcClient): DurableOrchestrationStarter {
  return {
    getOrchestrationState: (instanceId, fetchPayloads) =>
      client.getOrchestrationState(instanceId, fetchPayloads),
    scheduleNewOrchestration: (orchestrator, input, options) =>
      client.scheduleNewOrchestration(orchestrator, input, options),
  };
}
