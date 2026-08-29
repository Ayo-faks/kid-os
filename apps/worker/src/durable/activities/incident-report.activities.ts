import type {
  ExportSignal,
  IncidentActor,
  IncidentStatus,
  SubmitForApprovalSignal,
  UpdateDraftSignal,
} from '@careos/contracts';
import type { ActivityContext } from '@microsoft/durabletask-js';

import { ensureIncidentFollowUpActions } from '../../activities/incident-follow-ups.js';
import {
  exportPdf,
  persistIncidentVersion,
  resolveIncidentApprovalRequirement,
  routeForApproval,
  validateAgainstSchema,
  writeAuditEvent,
} from '../../activities/incidents.js';
import { withTenantContext } from '../../db/pg.js';
import type { ApprovalRoutingOrchestratorInput } from '../approval-routing.contracts.js';
import {
  type ApplyIncidentCommandInput,
  type ApplyIncidentCommandResult,
  type DurableIncidentState,
  type IncidentReportOrchestratorInput,
  type RecordIncidentApprovalResultInput,
  type RecordIncidentApprovalResultResult,
} from '../incident-report.contracts.js';

interface IncidentCommandRow {
  readonly command_type: string;
  readonly payload: unknown;
}

interface IncidentContextRow {
  readonly author_user_id: string;
  readonly form_data: unknown;
  readonly missing_mandatory: string[];
  readonly resident_id: string;
  readonly status: IncidentStatus;
  readonly template_id: string;
  readonly template_version: string;
  readonly version: number;
}

export async function initializeIncidentFromCommandActivity(
  _context: ActivityContext,
  input: IncidentReportOrchestratorInput,
): Promise<DurableIncidentState> {
  const command = await loadIncidentCommand(
    input.initialCommandId,
    input.incidentId,
    input.tenantId,
    input.homeId,
    input.actor,
    'incident.initialize',
  );
  const payload = parseInitialPayload(command.payload);
  const formData = payload.initialFormData ?? {};
  const validation = await validateAgainstSchema({ formData, formTemplate: input.formTemplate });
  const status: IncidentStatus = validation.valid ? 'draft' : 'awaiting_fields';
  await persistIncidentVersion({
    actor: input.actor,
    authorUserId: input.authorUserId,
    formData,
    formTemplate: input.formTemplate,
    homeId: input.homeId,
    incidentId: input.incidentId,
    missingMandatory: validation.missingMandatory,
    residentId: input.residentId,
    status,
    tenantId: input.tenantId,
    validationErrors: validation.errors,
    version: 1,
    workflowId: `incident-${input.incidentId}`,
  });
  await markIncidentCommandApplied(
    input.initialCommandId,
    input.incidentId,
    input.tenantId,
    input.homeId,
    input.actor,
  );
  return state(input.incidentId, 1, status, validation.missingMandatory);
}

export async function applyIncidentCommandActivity(
  _context: ActivityContext,
  input: ApplyIncidentCommandInput,
): Promise<ApplyIncidentCommandResult> {
  const systemActor: IncidentActor = {
    correlationId: `incident-command:${input.commandId}`,
    kind: 'system',
    userId: null,
  };
  const command = await loadIncidentCommand(
    input.commandId,
    input.incidentId,
    input.tenantId,
    input.homeId,
    systemActor,
  );
  const current = await loadIncidentContext(input, systemActor);

  switch (command.command_type) {
    case 'incident.update':
      return applyDraftUpdate(input, current, parseUpdateSignal(command.payload));
    case 'incident.submit':
      return applySubmission(input, current, parseSubmitSignal(command.payload));
    case 'incident.export':
      return applyExport(input, current, parseExportSignal(command.payload));
    default:
      throw new Error(`Unsupported incident command type ${command.command_type}.`);
  }
}

export async function recordIncidentApprovalResultActivity(
  _context: ActivityContext,
  input: RecordIncidentApprovalResultInput,
): Promise<RecordIncidentApprovalResultResult> {
  if (input.approval.status === 'pending') {
    throw new Error('Incident approval result must be terminal.');
  }
  const terminalSignature = input.approval.signatures.at(-1);
  if (terminalSignature === undefined) {
    throw new Error('Incident approval result must include a human signature.');
  }
  const actor: IncidentActor = {
    correlationId: input.correlationId,
    kind: 'user',
    userId: terminalSignature.userId,
  };
  const current = await loadIncidentContext(
    {
      commandId: input.approval.approvalId,
      currentVersion: 0,
      homeId: input.homeId,
      incidentId: input.incidentId,
      status: 'awaiting_approval',
      tenantId: input.tenantId,
    },
    actor,
  );
  const nextVersion = current.version + 1;
  await persistIncidentVersion({
    actor,
    authorUserId: current.author_user_id,
    formData: asRecord(current.form_data),
    formTemplate: {
      templateId: current.template_id,
      version: current.template_version,
    },
    homeId: input.homeId,
    incidentId: input.incidentId,
    missingMandatory: current.missing_mandatory,
    residentId: current.resident_id,
    status: input.approval.status,
    tenantId: input.tenantId,
    validationErrors: [],
    version: nextVersion,
    workflowId: `incident-${input.incidentId}`,
  });

  let followUps: RecordIncidentApprovalResultResult['followUps'] = [];
  if (input.approval.status === 'approved') {
    const requirement = await resolveIncidentApprovalRequirement({
      formData: asRecord(current.form_data),
      formTemplate: {
        templateId: current.template_id,
        version: current.template_version,
      },
    });
    followUps = await ensureIncidentFollowUpActions({
      actor,
      homeId: input.homeId,
      immediateRisk: requirement.immediateRisk,
      incidentId: input.incidentId,
      orchestrationName: 'IncidentFollowUpActionOrchestratorV1',
      orchestrationVersion: '1.0.0',
      runtime: 'durable',
      safeguarding: requirement.safeguarding,
      tenantId: input.tenantId,
    });
  } else {
    await markIncidentWorkflowCompleted(input.incidentId, input.tenantId, input.homeId, actor);
  }

  return {
    followUps,
    state: state(input.incidentId, nextVersion, input.approval.status, current.missing_mandatory),
  };
}

async function applyDraftUpdate(
  input: ApplyIncidentCommandInput,
  current: IncidentContextRow,
  signal: UpdateDraftSignal,
): Promise<ApplyIncidentCommandResult> {
  const validation = await validateAgainstSchema({
    formData: signal.formData,
    formTemplate: { templateId: current.template_id, version: current.template_version },
  });
  const nextStatus: IncidentStatus = validation.valid ? 'draft' : 'awaiting_fields';
  const nextVersion = current.version + 1;
  await persistIncidentVersion({
    actor: signal.actor,
    authorUserId: current.author_user_id,
    formData: signal.formData,
    formTemplate: { templateId: current.template_id, version: current.template_version },
    homeId: input.homeId,
    incidentId: input.incidentId,
    missingMandatory: validation.missingMandatory,
    residentId: current.resident_id,
    status: nextStatus,
    tenantId: input.tenantId,
    validationErrors: validation.errors,
    version: nextVersion,
    workflowId: `incident-${input.incidentId}`,
  });
  await markIncidentCommandApplied(
    input.commandId,
    input.incidentId,
    input.tenantId,
    input.homeId,
    signal.actor,
  );
  return {
    kind: 'state',
    state: state(input.incidentId, nextVersion, nextStatus, validation.missingMandatory),
  };
}

async function applySubmission(
  input: ApplyIncidentCommandInput,
  current: IncidentContextRow,
  signal: SubmitForApprovalSignal,
): Promise<ApplyIncidentCommandResult> {
  if (signal.actor.kind === 'system') {
    throw new Error('System actors cannot submit incidents for human approval.');
  }
  const formData = asRecord(current.form_data);
  const formTemplate = { templateId: current.template_id, version: current.template_version };
  const validation = await validateAgainstSchema({ formData, formTemplate });
  const nextVersion = current.version + 1;
  if (!validation.valid) {
    await persistIncidentVersion({
      actor: signal.actor,
      authorUserId: current.author_user_id,
      formData,
      formTemplate,
      homeId: input.homeId,
      incidentId: input.incidentId,
      missingMandatory: validation.missingMandatory,
      residentId: current.resident_id,
      status: 'awaiting_fields',
      tenantId: input.tenantId,
      validationErrors: validation.errors,
      version: nextVersion,
      workflowId: `incident-${input.incidentId}`,
    });
    await writeAuditEvent({
      actor: signal.actor,
      eventType: 'incident.submit_rejected_missing_fields',
      homeId: input.homeId,
      incidentId: input.incidentId,
      payload: { missingMandatory: validation.missingMandatory },
      residentId: current.resident_id,
      tenantId: input.tenantId,
    });
    await markIncidentCommandApplied(
      input.commandId,
      input.incidentId,
      input.tenantId,
      input.homeId,
      signal.actor,
    );
    return {
      kind: 'state',
      state: state(input.incidentId, nextVersion, 'awaiting_fields', validation.missingMandatory),
    };
  }

  const requirement = await resolveIncidentApprovalRequirement({ formData, formTemplate });
  await persistIncidentVersion({
    actor: signal.actor,
    authorUserId: current.author_user_id,
    formData,
    formTemplate,
    homeId: input.homeId,
    incidentId: input.incidentId,
    missingMandatory: [],
    residentId: current.resident_id,
    status: 'awaiting_approval',
    tenantId: input.tenantId,
    validationErrors: [],
    version: nextVersion,
    workflowId: `incident-${input.incidentId}`,
  });
  await routeForApproval({
    actor: signal.actor,
    homeId: input.homeId,
    immediateRisk: requirement.immediateRisk,
    incidentId: input.incidentId,
    residentId: current.resident_id,
    safeguarding: requirement.safeguarding,
    tenantId: input.tenantId,
    version: nextVersion,
  });
  await writeAuditEvent({
    actor: signal.actor,
    eventType: 'incident.routed_for_approval',
    homeId: input.homeId,
    incidentId: input.incidentId,
    payload: {
      immediateRisk: requirement.immediateRisk,
      requiredRoles: requirement.requiredRoles,
      safeguarding: requirement.safeguarding,
      signaturesRequired: requirement.signaturesRequired,
      version: nextVersion,
    },
    residentId: current.resident_id,
    tenantId: input.tenantId,
  });
  await markIncidentCommandApplied(
    input.commandId,
    input.incidentId,
    input.tenantId,
    input.homeId,
    signal.actor,
  );
  const approval: ApprovalRoutingOrchestratorInput = {
    actor: signal.actor,
    approvalId: input.incidentId,
    homeId: input.homeId,
    requestedByUserId: current.author_user_id,
    requiredRoles: requirement.requiredRoles,
    signaturesRequired: requirement.signaturesRequired,
    subjectId: input.incidentId,
    subjectType: 'incident',
    tenantId: input.tenantId,
  };
  return {
    approval,
    kind: 'await_approval',
    state: state(input.incidentId, nextVersion, 'awaiting_approval', []),
  };
}

async function applyExport(
  input: ApplyIncidentCommandInput,
  current: IncidentContextRow,
  signal: ExportSignal,
): Promise<ApplyIncidentCommandResult> {
  if (current.status !== 'approved') {
    await markIncidentCommandApplied(
      input.commandId,
      input.incidentId,
      input.tenantId,
      input.homeId,
      signal.actor,
    );
    return {
      kind: 'state',
      state: state(input.incidentId, current.version, current.status, current.missing_mandatory),
    };
  }
  const exported = await exportPdf({
    actor: signal.actor,
    formData: asRecord(current.form_data),
    formTemplate: { templateId: current.template_id, version: current.template_version },
    homeId: input.homeId,
    incidentId: input.incidentId,
    residentId: current.resident_id,
    tenantId: input.tenantId,
    version: current.version,
  });
  await writeAuditEvent({
    actor: signal.actor,
    eventType: 'incident.exported',
    homeId: input.homeId,
    incidentId: input.incidentId,
    payload: {
      objectKey: exported.objectKey,
      sha256: exported.sha256,
      sizeBytes: exported.sizeBytes,
    },
    residentId: current.resident_id,
    tenantId: input.tenantId,
  });
  await markIncidentCommandApplied(
    input.commandId,
    input.incidentId,
    input.tenantId,
    input.homeId,
    signal.actor,
  );
  await markIncidentWorkflowCompleted(input.incidentId, input.tenantId, input.homeId, signal.actor);
  return {
    kind: 'state',
    state: {
      ...state(input.incidentId, current.version, 'exported', current.missing_mandatory),
      exportObjectKey: exported.objectKey,
    },
  };
}

async function loadIncidentCommand(
  commandId: string,
  incidentId: string,
  tenantId: string,
  homeId: string,
  actor: IncidentActor,
  expectedType?: string,
): Promise<IncidentCommandRow> {
  return withTenantContext({ actor, homeId, tenantId }, async (client) => {
    const result = await client.query<IncidentCommandRow>(
      `SELECT c.command_type, c.payload
         FROM core.workflow_commands c
         JOIN core.workflow_instances w ON w.id = c.workflow_instance_id
        WHERE c.id = $1::uuid
          AND w.workflow_kind = 'incident'
          AND w.subject_type = 'incident'
          AND w.subject_id = $2::uuid
          AND w.runtime = 'durable'::"core"."WorkflowRuntimeKind"
          AND ($3::text IS NULL OR c.command_type = $3)
        LIMIT 1`,
      [commandId, incidentId, expectedType ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Incident command ${commandId} was not found.`);
    return row;
  });
}

async function loadIncidentContext(
  input: ApplyIncidentCommandInput,
  actor: IncidentActor,
): Promise<IncidentContextRow> {
  return withTenantContext(
    { actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<IncidentContextRow>(
        `SELECT
         i.author_user_id::text,
         i.resident_id::text,
         i.status::text AS status,
         i.current_version AS version,
         ft.template_id,
         ft.version AS template_version,
         v.form_data,
         v.missing_mandatory
       FROM core.incidents i
       JOIN core.form_templates ft ON ft.id = i.form_template_id
       JOIN core.incident_versions v
         ON v.incident_id = i.id AND v.version = i.current_version
       WHERE i.id = $1::uuid AND i.soft_deleted_at IS NULL
       LIMIT 1`,
        [input.incidentId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error(`Incident ${input.incidentId} was not found.`);
      return row;
    },
  );
}

async function markIncidentCommandApplied(
  commandId: string,
  incidentId: string,
  tenantId: string,
  homeId: string,
  actor: IncidentActor,
): Promise<void> {
  await withTenantContext({ actor, homeId, tenantId }, async (client) => {
    await client.query(
      `UPDATE core.workflow_commands c
          SET status = 'applied'::"core"."WorkflowCommandStatus",
              failure_reason = NULL,
              processed_at = now(),
              updated_at = now()
         FROM core.workflow_instances w
        WHERE c.id = $1::uuid
          AND w.id = c.workflow_instance_id
          AND w.workflow_kind = 'incident'
          AND w.subject_id = $2::uuid`,
      [commandId, incidentId],
    );
  });
}

async function markIncidentWorkflowCompleted(
  incidentId: string,
  tenantId: string,
  homeId: string,
  actor: IncidentActor,
): Promise<void> {
  await withTenantContext({ actor, homeId, tenantId }, async (client) => {
    await client.query(
      `UPDATE core.workflow_instances
          SET status = 'completed', updated_at = now()
        WHERE workflow_kind = 'incident'
          AND subject_type = 'incident'
          AND subject_id = $1::uuid
          AND runtime = 'durable'::"core"."WorkflowRuntimeKind"`,
      [incidentId],
    );
  });
}

function parseInitialPayload(value: unknown): {
  readonly initialFormData?: Record<string, unknown>;
} {
  if (typeof value !== 'object' || value === null)
    throw new Error('Incident initialization payload is invalid.');
  const payload = value as Record<string, unknown>;
  if (payload.initialFormData !== undefined && !isRecord(payload.initialFormData)) {
    throw new Error('Incident initialization payload is invalid.');
  }
  return payload.initialFormData === undefined ? {} : { initialFormData: payload.initialFormData };
}

function parseUpdateSignal(value: unknown): UpdateDraftSignal {
  if (typeof value !== 'object' || value === null)
    throw new Error('Incident update payload is invalid.');
  const payload = value as Record<string, unknown>;
  if (!isIncidentActor(payload.actor) || !isRecord(payload.formData)) {
    throw new Error('Incident update payload is invalid.');
  }
  return { actor: payload.actor, formData: payload.formData };
}

function parseSubmitSignal(value: unknown): SubmitForApprovalSignal {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('actor' in value) ||
    !isIncidentActor(value.actor)
  ) {
    throw new Error('Incident submit payload is invalid.');
  }
  return { actor: value.actor };
}

function parseExportSignal(value: unknown): ExportSignal {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('actor' in value) ||
    !isIncidentActor(value.actor)
  ) {
    throw new Error('Incident export payload is invalid.');
  }
  return { actor: value.actor };
}

function isIncidentActor(value: unknown): value is IncidentActor {
  if (typeof value !== 'object' || value === null) return false;
  const actor = value as Record<string, unknown>;
  return (
    (actor.kind === 'user' || actor.kind === 'agent' || actor.kind === 'system') &&
    (typeof actor.userId === 'string' || actor.userId === null) &&
    typeof actor.correlationId === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Incident form data is invalid.');
  return value;
}

function state(
  incidentId: string,
  currentVersion: number,
  status: IncidentStatus,
  missingMandatory: readonly string[],
): DurableIncidentState {
  return { currentVersion, incidentId, missingMandatory, status };
}
