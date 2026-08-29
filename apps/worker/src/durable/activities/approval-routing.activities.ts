import type {
  ApplyApprovalDecisionResult,
  ApprovalActor,
  ApprovalDecisionSignal,
  CreateApprovalRequestResult,
} from '@careos/contracts';
import type { ActivityContext } from '@microsoft/durabletask-js';

import { applyApprovalDecision, createApprovalRequest } from '../../activities/approvals.js';
import { withTenantContext } from '../../db/pg.js';
import {
  APPROVAL_ORCHESTRATION_VERSION,
  APPROVAL_ROUTING_ORCHESTRATOR,
  type ApplyApprovalDecisionCommandInput,
  type CreateApprovalRequestFromReferenceInput,
  type DurableApprovalState,
} from '../approval-routing.contracts.js';

interface ApprovalReferenceText {
  readonly summary: string;
  readonly title: string;
}

interface WorkflowCommandRow {
  readonly payload: unknown;
  readonly status: 'pending' | 'processing' | 'applied' | 'failed';
}

export async function createApprovalRequestFromReferenceActivity(
  _context: ActivityContext,
  input: CreateApprovalRequestFromReferenceInput,
): Promise<DurableApprovalState> {
  const reference = await loadApprovalReference(input);
  const created = await createApprovalRequest({
    ...input,
    orchestrationName: APPROVAL_ROUTING_ORCHESTRATOR,
    orchestrationVersion: APPROVAL_ORCHESTRATION_VERSION,
    runtime: 'durable',
    summary: reference.summary,
    title: reference.title,
  });
  return stateFromCreate(input, created);
}

export async function applyApprovalDecisionCommandActivity(
  _context: ActivityContext,
  input: ApplyApprovalDecisionCommandInput,
): Promise<DurableApprovalState> {
  const systemActor: ApprovalActor = {
    correlationId: `approval-command:${input.commandId}`,
    kind: 'system',
    userId: null,
  };
  const command = await loadApprovalCommand(input, systemActor);
  const decision = parseApprovalDecisionSignal(command.payload);

  await markCommandStatus(input, decision.actor, 'processing');
  try {
    const result = await applyApprovalDecision({
      actor: decision.actor,
      approvalId: input.approvalId,
      decidedByUserId: decision.decidedByUserId,
      decision: decision.decision,
      homeId: input.homeId,
      reason: decision.reason,
      tenantId: input.tenantId,
    });
    await markCommandApplied(input, decision.actor, result.status);
    return stateFromDecision(result);
  } catch (error) {
    await markCommandStatus(
      input,
      decision.actor,
      'failed',
      error instanceof Error ? error.message.slice(0, 500) : 'Approval command failed.',
    );
    throw error;
  }
}

async function loadApprovalReference(
  input: CreateApprovalRequestFromReferenceInput,
): Promise<ApprovalReferenceText> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const existing = await client.query<ApprovalReferenceText>(
        `SELECT title, summary
           FROM core.approvals
          WHERE id = $1::uuid
          LIMIT 1`,
        [input.approvalId],
      );
      if (existing.rows[0] !== undefined) return existing.rows[0];

      if (input.subjectType === 'email_draft') {
        const email = await client.query<ApprovalReferenceText>(
          `SELECT subject AS title, body AS summary
             FROM core.email_drafts
            WHERE id = $1::uuid
              AND soft_deleted_at IS NULL
            LIMIT 1`,
          [input.subjectId],
        );
        if (email.rows[0] !== undefined) return email.rows[0];
      } else {
        const incident = await client.query<ApprovalReferenceText>(
          `SELECT
             CASE
               WHEN 'safeguarding_lead' = ANY($2::text[])
                 THEN 'Safeguarding incident review'::text
               ELSE 'Incident review'::text
             END AS title,
             COALESCE(
               NULLIF(v.form_data ->> 'summary', ''),
               'Incident ' || i.id::text
             ) AS summary
             FROM core.incidents i
             JOIN core.incident_versions v
               ON v.incident_id = i.id
              AND v.version = i.current_version
            WHERE i.id = $1::uuid
              AND i.soft_deleted_at IS NULL
            LIMIT 1`,
          [input.subjectId, input.requiredRoles],
        );
        if (incident.rows[0] !== undefined) return incident.rows[0];
      }

      throw new Error(
        `Approval subject ${input.subjectType}:${input.subjectId} was not found in the active home.`,
      );
    },
  );
}

async function loadApprovalCommand(
  input: ApplyApprovalDecisionCommandInput,
  actor: ApprovalActor,
): Promise<WorkflowCommandRow> {
  return withTenantContext(
    { actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<WorkflowCommandRow>(
        `SELECT c.payload, c.status::text AS status
           FROM core.workflow_commands c
           JOIN core.workflow_instances w ON w.id = c.workflow_instance_id
          WHERE c.id = $1::uuid
            AND c.command_type = 'approval.decision'
            AND w.workflow_kind = 'approval'
            AND w.subject_type = 'approval'
            AND w.subject_id = $2::uuid
            AND w.runtime = 'durable'::"core"."WorkflowRuntimeKind"
          LIMIT 1`,
        [input.commandId, input.approvalId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`Approval command ${input.commandId} was not found.`);
      }
      return row;
    },
  );
}

async function markCommandStatus(
  input: ApplyApprovalDecisionCommandInput,
  actor: ApprovalActor,
  status: 'processing' | 'failed',
  failureReason?: string,
): Promise<void> {
  await withTenantContext(
    { actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_commands
            SET status = $2::"core"."WorkflowCommandStatus",
                failure_reason = $3,
                updated_at = now()
          WHERE id = $1::uuid
            AND status <> 'applied'::"core"."WorkflowCommandStatus"`,
        [input.commandId, status, failureReason ?? null],
      );
    },
  );
}

async function markCommandApplied(
  input: ApplyApprovalDecisionCommandInput,
  actor: ApprovalActor,
  approvalStatus: ApplyApprovalDecisionResult['status'],
): Promise<void> {
  await withTenantContext(
    { actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_commands
            SET status = 'applied'::"core"."WorkflowCommandStatus",
                failure_reason = NULL,
                processed_at = now(),
                updated_at = now()
          WHERE id = $1::uuid`,
        [input.commandId],
      );
      if (approvalStatus !== 'pending') {
        await client.query(
          `UPDATE core.workflow_instances
              SET status = 'completed', updated_at = now()
            WHERE workflow_kind = 'approval'
              AND subject_type = 'approval'
              AND subject_id = $1::uuid
              AND runtime = 'durable'::"core"."WorkflowRuntimeKind"`,
          [input.approvalId],
        );
      }
    },
  );
}

function parseApprovalDecisionSignal(value: unknown): ApprovalDecisionSignal {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Approval command payload is invalid.');
  }
  const payload = value as Record<string, unknown>;
  if (
    (payload.decision !== 'approved' && payload.decision !== 'rejected') ||
    typeof payload.decidedByUserId !== 'string' ||
    (payload.reason !== undefined && typeof payload.reason !== 'string') ||
    !isApprovalActor(payload.actor)
  ) {
    throw new Error('Approval command payload is invalid.');
  }
  return {
    actor: payload.actor,
    decidedByUserId: payload.decidedByUserId,
    decision: payload.decision,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
  };
}

function isApprovalActor(value: unknown): value is ApprovalActor {
  if (typeof value !== 'object' || value === null) return false;
  const actor = value as Record<string, unknown>;
  return (
    (actor.kind === 'user' || actor.kind === 'agent' || actor.kind === 'system') &&
    (typeof actor.userId === 'string' || actor.userId === null) &&
    typeof actor.correlationId === 'string'
  );
}

function stateFromCreate(
  input: CreateApprovalRequestFromReferenceInput,
  result: CreateApprovalRequestResult,
): DurableApprovalState {
  return {
    approvalId: result.approvalId,
    requiredRoles: result.requiredRoles,
    signatures: result.signatures.map(({ decision, role, userId }) => ({
      decision,
      role,
      userId,
    })),
    signaturesRequired: result.signaturesRequired,
    status: result.status,
    subjectId: input.subjectId,
    subjectType: input.subjectType,
  };
}

function stateFromDecision(result: ApplyApprovalDecisionResult): DurableApprovalState {
  return {
    approvalId: result.approvalId,
    requiredRoles: result.requiredRoles,
    signatures: result.signatures.map(({ decision, role, userId }) => ({
      decision,
      role,
      userId,
    })),
    signaturesRequired: result.signaturesRequired,
    status: result.status,
    subjectId: result.subjectId,
    subjectType: result.subjectType,
  };
}
