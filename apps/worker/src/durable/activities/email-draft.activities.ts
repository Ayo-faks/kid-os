import type {
  DraftEmailResult,
  EmailDraftActor,
  EmailDraftStatus,
  EmailDraftWorkflowInput,
} from '@careos/contracts';
import { emailDraftWorkflowId } from '@careos/contracts';
import type { ActivityContext } from '@microsoft/durabletask-js';

import { resolveApprovalRequirementActivity } from '../../activities/approvals.js';
import {
  dispatchEmailDraftNotifications,
  draftEmail,
  persistEmailDraft,
  validateEmailDraft,
} from '../../activities/email-drafts.js';
import { withTenantContext } from '../../db/pg.js';
import type { ApprovalRoutingOrchestratorInput } from '../approval-routing.contracts.js';
import type {
  DurableEmailDraftState,
  EmailDraftOrchestratorInput,
  FinalizeEmailDraftFailureInput,
  ProcessEmailDraftCommandResult,
} from '../email-draft.contracts.js';

interface EmailDraftCommandRow {
  readonly failure_reason: string | null;
  readonly payload: unknown;
  readonly status: 'pending' | 'processing' | 'applied' | 'failed';
}

interface EmailDraftRow {
  readonly sensitivity: 'routine' | 'sensitive';
  readonly status: EmailDraftStatus;
}

type DraftResult = Omit<DraftEmailResult, 'promptHash'> & { readonly promptHash?: string };

export async function processEmailDraftCommandActivity(
  _context: ActivityContext,
  input: EmailDraftOrchestratorInput,
): Promise<ProcessEmailDraftCommandResult> {
  const command = await loadCommand(input);
  if (command.status === 'applied') return rehydrateAppliedResult(input);
  if (command.status === 'failed') {
    return {
      kind: 'state',
      state: failedState(input.emailDraftId, failureOutcome(command.failure_reason)),
    };
  }

  await markCommandProcessing(input);
  try {
    const payload = parseEmailDraftPayload(command.payload, input);
    const draft = await resolveDraft(payload);
    if (draft.refused) {
      await markTerminalOutcome(input, 'failed', 'email-draft-refused');
      return {
        kind: 'state',
        state: {
          ...failedState(input.emailDraftId, 'refused'),
          missingMandatory: draft.missingMandatory,
          sensitivity: draft.sensitivity,
        },
      };
    }

    const validation = await validateEmailDraft({ formData: draft.formData });
    if (!validation.valid) {
      await markTerminalOutcome(input, 'failed', 'email-draft-validation-failed');
      return {
        kind: 'state',
        state: {
          ...failedState(input.emailDraftId, 'validation-failed'),
          missingMandatory: validation.missingMandatory,
          sensitivity: draft.sensitivity,
        },
      };
    }

    const requirement = await resolveApprovalRequirementActivity({
      context: { sensitivity: draft.sensitivity },
      skill: 'draft_email',
    });
    const targetStatus: EmailDraftStatus = requirement.level === 'none' ? 'draft' : 'needs_review';
    const actor = draftActor(payload, draft.promptHash);
    const persisted = await persistEmailDraft({
      actor,
      authorUserId: payload.authorUserId,
      body: draft.body,
      emailDraftId: payload.emailDraftId,
      homeId: payload.homeId,
      recipient: payload.recipient,
      sensitivity: draft.sensitivity,
      sensitivityReasons: draft.sensitivityReasons,
      source: payload.source,
      status: targetStatus,
      subject: draft.subject,
      tenantId: payload.tenantId,
      workflowId: emailDraftWorkflowId(payload.emailDraftId),
    });
    await dispatchEmailDraftNotifications({
      actor,
      emailDraftId: payload.emailDraftId,
      homeId: payload.homeId,
      sensitivity: draft.sensitivity,
      status: persisted.status,
      tenantId: payload.tenantId,
    });
    await markTerminalOutcome(input, 'applied', null);

    const state: DurableEmailDraftState = {
      emailDraftId: input.emailDraftId,
      missingMandatory: [],
      sensitivity: persisted.sensitivity,
      status: persisted.status,
    };
    if (
      persisted.status === 'needs_review' &&
      (requirement.signaturesRequired === 1 || requirement.signaturesRequired === 2)
    ) {
      return {
        approval: approvalInput(input, actor, {
          requiredRoles: requirement.requiredRoles,
          signaturesRequired: requirement.signaturesRequired,
        }),
        kind: 'await_approval',
        state,
      };
    }
    return { kind: 'state', state };
  } catch (error) {
    try {
      await recordAttemptFailure(input, deepestErrorMessage(error));
    } catch {
      // The scheduler error remains generic even if diagnostic persistence fails.
    }
    throw new Error('Email draft command processing failed.');
  }
}

export async function finalizeEmailDraftFailureActivity(
  _context: ActivityContext,
  input: FinalizeEmailDraftFailureInput,
): Promise<void> {
  try {
    await markTerminalOutcome(input, 'failed', 'email-draft-processing-failed');
  } catch {
    throw new Error('Email draft failure finalization failed.');
  }
}

async function resolveDraft(payload: EmailDraftWorkflowInput): Promise<DraftResult> {
  if (payload.preparedDraft !== undefined) {
    return {
      body: payload.preparedDraft.body,
      confidence: 1,
      formData: {
        body: payload.preparedDraft.body,
        recipient: payload.recipient,
        sensitivity: payload.preparedDraft.sensitivity,
        sensitivity_reasons: payload.preparedDraft.sensitivityReasons,
        subject: payload.preparedDraft.subject,
      },
      missingMandatory: [],
      refused: false,
      sensitivity: payload.preparedDraft.sensitivity,
      sensitivityReasons: payload.preparedDraft.sensitivityReasons,
      subject: payload.preparedDraft.subject,
    };
  }
  return draftEmail({
    correlationId: payload.correlationId,
    homeId: payload.homeId,
    instructions: payload.instructions,
    recipient: payload.recipient,
    source: payload.source,
    tenantId: payload.tenantId,
  });
}

async function rehydrateAppliedResult(
  input: EmailDraftOrchestratorInput,
): Promise<ProcessEmailDraftCommandResult> {
  const row = await loadEmailDraft(input);
  const state: DurableEmailDraftState = {
    emailDraftId: input.emailDraftId,
    missingMandatory: [],
    sensitivity: row.sensitivity,
    status: row.status,
  };
  if (row.status !== 'needs_review') return { kind: 'state', state };

  const requirement = await resolveApprovalRequirementActivity({
    context: { sensitivity: row.sensitivity },
    skill: 'draft_email',
  });
  if (requirement.signaturesRequired !== 1 && requirement.signaturesRequired !== 2) {
    throw new Error('Email draft review state has no approval requirement.');
  }
  return {
    approval: approvalInput(input, input.actor, {
      requiredRoles: requirement.requiredRoles,
      signaturesRequired: requirement.signaturesRequired,
    }),
    kind: 'await_approval',
    state,
  };
}

function approvalInput(
  input: EmailDraftOrchestratorInput,
  actor: EmailDraftActor,
  requirement: {
    readonly requiredRoles: ApprovalRoutingOrchestratorInput['requiredRoles'];
    readonly signaturesRequired: 1 | 2;
  },
): ApprovalRoutingOrchestratorInput {
  return {
    actor,
    approvalId: input.emailDraftId,
    homeId: input.homeId,
    requestedByUserId: input.authorUserId,
    requiredRoles: requirement.requiredRoles,
    signaturesRequired: requirement.signaturesRequired,
    subjectId: input.emailDraftId,
    subjectType: 'email_draft',
    tenantId: input.tenantId,
  };
}

function draftActor(payload: EmailDraftWorkflowInput, promptHash?: string): EmailDraftActor {
  const actor = payload.actor ?? {
    correlationId: payload.correlationId,
    kind: 'user' as const,
    userId: payload.authorUserId,
  };
  return { ...actor, ...(promptHash === undefined ? {} : { promptHash }) };
}

async function loadCommand(input: EmailDraftOrchestratorInput): Promise<EmailDraftCommandRow> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<EmailDraftCommandRow>(
        `SELECT c.payload, c.status::text AS status, c.failure_reason
           FROM core.workflow_commands c
           JOIN core.workflow_instances w ON w.id = c.workflow_instance_id
          WHERE c.id = $1::uuid
            AND c.command_type = 'email-draft.initialize'
            AND w.workflow_kind = 'email-draft'
            AND w.subject_type = 'email_draft'
            AND w.subject_id = $2::uuid
            AND w.runtime = 'durable'::"core"."WorkflowRuntimeKind"
          LIMIT 1`,
        [input.commandId, input.emailDraftId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('Email draft command was not found.');
      return row;
    },
  );
}

async function loadEmailDraft(input: EmailDraftOrchestratorInput): Promise<EmailDraftRow> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<EmailDraftRow>(
        `SELECT status::text AS status, sensitivity::text AS sensitivity
           FROM core.email_drafts
          WHERE id = $1::uuid AND soft_deleted_at IS NULL
          LIMIT 1`,
        [input.emailDraftId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('Applied Email draft command has no draft row.');
      return row;
    },
  );
}

async function markCommandProcessing(input: EmailDraftOrchestratorInput): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_commands
            SET status = 'processing'::"core"."WorkflowCommandStatus",
                updated_at = now()
          WHERE id = $1::uuid
            AND status = 'pending'::"core"."WorkflowCommandStatus"`,
        [input.commandId],
      );
    },
  );
}

async function recordAttemptFailure(
  input: EmailDraftOrchestratorInput,
  failureDetail: string,
): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_commands
            SET failure_reason = $2, updated_at = now()
          WHERE id = $1::uuid
            AND status = 'processing'::"core"."WorkflowCommandStatus"`,
        [input.commandId, failureDetail.slice(0, 500)],
      );
    },
  );
}

async function markTerminalOutcome(
  input: Pick<
    EmailDraftOrchestratorInput,
    'actor' | 'commandId' | 'emailDraftId' | 'homeId' | 'tenantId'
  >,
  commandStatus: 'applied' | 'failed',
  failureDetail: string | null,
): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_commands
            SET status = $2::"core"."WorkflowCommandStatus",
                failure_reason = $3,
                processed_at = now(),
                updated_at = now()
          WHERE id = $1::uuid
            AND status <> 'applied'::"core"."WorkflowCommandStatus"`,
        [input.commandId, commandStatus, failureDetail],
      );
      await client.query(
        `UPDATE core.workflow_instances
            SET status = $2, updated_at = now()
          WHERE workflow_kind = 'email-draft'
            AND subject_type = 'email_draft'
            AND subject_id = $1::uuid
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"
            AND status <> 'completed'`,
        [input.emailDraftId, commandStatus === 'applied' ? 'completed' : 'failed'],
      );
    },
  );
}

function parseEmailDraftPayload(
  value: unknown,
  input: EmailDraftOrchestratorInput,
): EmailDraftWorkflowInput {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Email draft command payload is invalid.');
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.emailDraftId !== input.emailDraftId ||
    payload.tenantId !== input.tenantId ||
    payload.homeId !== input.homeId ||
    payload.authorUserId !== input.authorUserId ||
    payload.correlationId !== input.actor.correlationId ||
    typeof payload.instructions !== 'string' ||
    !isRecipient(payload.recipient) ||
    !isSource(payload.source) ||
    (payload.actor !== undefined &&
      (!isEmailDraftActor(payload.actor) ||
        payload.actor.correlationId !== input.actor.correlationId)) ||
    (payload.preparedDraft !== undefined && !isPreparedDraft(payload.preparedDraft))
  ) {
    throw new Error('Email draft command payload is invalid.');
  }
  return payload as unknown as EmailDraftWorkflowInput;
}

function isEmailDraftActor(value: unknown): value is EmailDraftActor {
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'user' || value.kind === 'agent' || value.kind === 'system') &&
    (typeof value.userId === 'string' || value.userId === null) &&
    typeof value.correlationId === 'string'
  );
}

function isRecipient(value: unknown): boolean {
  if (!isRecord(value) || typeof value.email !== 'string') return false;
  return (
    (value.name === undefined || typeof value.name === 'string') &&
    (value.role === undefined || typeof value.role === 'string')
  );
}

function isSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'incident' || value.kind === 'handover' || value.kind === 'general') &&
    (value.id === undefined || typeof value.id === 'string') &&
    typeof value.summary === 'string'
  );
}

function isPreparedDraft(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.body === 'string' &&
    (value.sensitivity === 'routine' || value.sensitivity === 'sensitive') &&
    Array.isArray(value.sensitivityReasons) &&
    value.sensitivityReasons.every((entry) => typeof entry === 'string') &&
    typeof value.subject === 'string'
  );
}

function failedState(
  emailDraftId: string,
  outcomeCode: NonNullable<DurableEmailDraftState['outcomeCode']>,
): DurableEmailDraftState {
  return {
    emailDraftId,
    missingMandatory: [],
    outcomeCode,
    sensitivity: null,
    status: 'failed',
  };
}

function failureOutcome(
  failureDetail: string | null,
): NonNullable<DurableEmailDraftState['outcomeCode']> {
  if (failureDetail?.startsWith('email-draft-refused') === true) return 'refused';
  if (failureDetail?.startsWith('email-draft-validation-failed') === true) {
    return 'validation-failed';
  }
  return 'processing-failed';
}

function deepestErrorMessage(error: unknown): string {
  let current = error;
  let message = 'email-draft-unknown-error';
  while (current instanceof Error) {
    if (current.message !== '') message = current.message;
    current = current.cause;
  }
  return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
