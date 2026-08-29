import { createHash } from 'node:crypto';

import type {
  ApplyApprovalDecisionInput,
  ApplyApprovalDecisionResult,
  ApprovalRole,
  ApprovalSignature,
  ApprovalStatus,
  ApprovalSubjectType,
  CreateApprovalRequestInput,
  CreateApprovalRequestResult,
  EmailDraftStatus,
  IncidentStatus,
  ResolveApprovalRequirementInput,
  ResolveApprovalRequirementResult,
} from '@careos/contracts';
import { resolveApprovalRequirement } from '@careos/contracts';
import type { PoolClient } from 'pg';

import { withTenantContext } from '../db/pg.js';

interface ExistingApprovalRow {
  readonly id: string;
  readonly required_roles: ApprovalRole[];
  readonly signatures: unknown;
  readonly signatures_required: 1 | 2;
  readonly status: ApprovalStatus;
}

interface ApprovalDecisionRow extends ExistingApprovalRow {
  readonly subject_type: ApprovalSubjectType;
  readonly subject_id: string;
}

interface EmailDraftStatusRow {
  readonly status: EmailDraftStatus;
}

interface UserRolesRow {
  readonly roles: string[];
}

interface WorkflowOwnerRow {
  readonly instance_id: string;
  readonly runtime: 'durable' | 'temporal';
}

// eslint-disable-next-line @typescript-eslint/require-await -- Temporal activity contract is Promise-based
export async function resolveApprovalRequirementActivity(
  input: ResolveApprovalRequirementInput,
): Promise<ResolveApprovalRequirementResult> {
  return resolveApprovalRequirement(input.skill, input.context ?? {});
}

export async function createApprovalRequest(
  input: CreateApprovalRequestInput,
): Promise<CreateApprovalRequestResult> {
  return withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      const existing = await findApproval(client, input);
      if (existing !== undefined) {
        await registerApprovalOwner(client, input, existing.status);
        return toCreateResult(existing);
      }

      const requiredRoles = input.requiredRoles ?? ['manager'];
      const signaturesRequired = input.signaturesRequired ?? 1;

      await client.query(
        `INSERT INTO core.approvals (
           id, tenant_id, home_id, workflow_id, subject_type, subject_id,
           title, summary, status, requested_by_user_id, signatures_required,
           required_roles, signatures, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid,
           $7, $8, 'pending'::"core"."ApprovalStatus", $9::uuid, $10,
           $11::text[], '[]'::jsonb, now(), now()
         )
         ON CONFLICT (tenant_id, home_id, subject_type, subject_id) DO NOTHING`,
        [
          input.approvalId,
          input.tenantId,
          input.homeId,
          input.workflowId,
          input.subjectType,
          input.subjectId,
          input.title,
          input.summary,
          input.requestedByUserId,
          signaturesRequired,
          requiredRoles,
        ],
      );

      const persisted = await findApproval(client, input);
      if (persisted === undefined) {
        throw new Error(`Approval ${input.approvalId} was not persisted.`);
      }

      await registerApprovalOwner(client, input, persisted.status);

      return toCreateResult(persisted);
    },
  );
}

export async function applyApprovalDecision(
  input: ApplyApprovalDecisionInput,
): Promise<ApplyApprovalDecisionResult> {
  return withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      const approval = await client.query<ApprovalDecisionRow>(
        `SELECT
           id::text,
           status::text AS status,
           subject_type,
           subject_id::text,
           signatures_required,
           required_roles,
           signatures
         FROM core.approvals
         WHERE id = $1::uuid
         LIMIT 1
         FOR UPDATE`,
        [input.approvalId],
      );
      const row = approval.rows[0];
      if (row === undefined) {
        throw new Error(`Approval ${input.approvalId} was not found.`);
      }

      if (row.status !== 'pending') {
        return terminalResult(client, row);
      }

      const signatures = parseSignatures(row.signatures);
      const existingSignature = signatures.find(
        (signature) => signature.userId === input.decidedByUserId,
      );
      if (existingSignature !== undefined) {
        return resultFor(row, signatures, 'pending');
      }

      const userResult = await client.query<UserRolesRow>(
        `SELECT roles
           FROM core.users
          WHERE id = $1::uuid AND tenant_id = $2::uuid
          LIMIT 1`,
        [input.decidedByUserId, input.tenantId],
      );
      const userRoles = userResult.rows[0]?.roles ?? [];
      const signatureRole = roleForDecision(
        input.decision,
        userRoles,
        row.required_roles,
        signatures,
      );
      if (signatureRole === undefined) {
        throw new Error(
          `User ${input.decidedByUserId} does not cover an outstanding approval role.`,
        );
      }

      const signature: ApprovalSignature = {
        decidedAt: new Date().toISOString(),
        decision: input.decision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        role: signatureRole,
        userId: input.decidedByUserId,
      };
      const nextSignatures = [...signatures, signature];
      const nextStatus = terminalStatus(row, nextSignatures);

      await client.query(
        `UPDATE core.approvals
            SET status = $1::"core"."ApprovalStatus",
                signatures = $2::jsonb,
                decided_by_user_id = CASE WHEN $1::"core"."ApprovalStatus" = 'pending' THEN NULL ELSE $3::uuid END,
                decision_reason = CASE WHEN $1::"core"."ApprovalStatus" = 'pending' THEN NULL ELSE $4 END,
                decided_at = CASE WHEN $1::"core"."ApprovalStatus" = 'pending' THEN NULL ELSE now() END,
                updated_at = now()
          WHERE id = $5::uuid`,
        [
          nextStatus,
          JSON.stringify(nextSignatures),
          input.decidedByUserId,
          input.reason ?? null,
          row.id,
        ],
      );

      let emailDraftStatus: EmailDraftStatus | undefined;
      let incidentStatus: IncidentStatus | undefined;
      let outboxId: string | undefined;
      if (nextStatus !== 'pending' && row.subject_type === 'email_draft') {
        emailDraftStatus = await applyEmailDraftDecision(
          client,
          input.decidedByUserId,
          nextStatus,
          row.subject_id,
        );
        if (nextStatus === 'approved') {
          outboxId = stableUuid(`approval:${row.id}:email_draft_approved`);
          await client.query(
            `INSERT INTO core.outbox
               (id, tenant_id, home_id, topic, payload, status, attempts, available_at, created_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'novu.email_draft.approved', $4::jsonb,
               'pending', 0, now(), now())
             ON CONFLICT (id) DO NOTHING`,
            [
              outboxId,
              input.tenantId,
              input.homeId,
              JSON.stringify({
                approvalId: row.id,
                emailDraftId: row.subject_id,
                status: emailDraftStatus,
              }),
            ],
          );
        }
      }
      if (nextStatus !== 'pending' && row.subject_type === 'incident') {
        incidentStatus = nextStatus;
      }

      if (nextStatus !== 'pending') {
        await client.query(
          `UPDATE core.workflow_instances
              SET status = 'completed', updated_at = now()
            WHERE workflow_kind = 'approval'
              AND subject_type = 'approval'
              AND subject_id = $1::uuid`,
          [row.id],
        );
      }

      return {
        approvalId: row.id,
        emailDraftStatus,
        incidentStatus,
        outboxId,
        requiredRoles: row.required_roles,
        signatures: nextSignatures,
        signaturesRequired: row.signatures_required,
        status: nextStatus,
        subjectId: row.subject_id,
        subjectType: row.subject_type,
      };
    },
  );
}

async function registerApprovalOwner(
  client: PoolClient,
  input: CreateApprovalRequestInput,
  approvalStatus: ApprovalStatus,
): Promise<void> {
  const result = await client.query<WorkflowOwnerRow>(
    `INSERT INTO core.workflow_instances (
       id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
       runtime, instance_id, orchestration_name, orchestration_version,
       status, correlation_id, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), $1::uuid, $2::uuid, 'approval', 'approval', $3::uuid,
       $4::"core"."WorkflowRuntimeKind", $5, $6, $7,
       $8, $9, now(), now()
     )
     ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
     DO UPDATE SET instance_id = core.workflow_instances.instance_id
     RETURNING runtime::text AS runtime, instance_id`,
    [
      input.tenantId,
      input.homeId,
      input.approvalId,
      input.runtime,
      input.workflowId,
      input.orchestrationName,
      input.orchestrationVersion ?? null,
      approvalStatus === 'pending' ? 'running' : 'completed',
      input.actor.correlationId,
    ],
  );
  const owner = result.rows[0];
  if (owner === undefined) throw new Error(`Approval ${input.approvalId} owner was not persisted.`);
  if (owner.runtime !== input.runtime || owner.instance_id !== input.workflowId) {
    throw new Error(
      `Approval ${input.approvalId} is already owned by ${owner.runtime}:${owner.instance_id}.`,
    );
  }
}

async function findApproval(
  client: PoolClient,
  input: CreateApprovalRequestInput,
): Promise<ExistingApprovalRow | undefined> {
  const result = await client.query<ExistingApprovalRow>(
    `SELECT id::text, status::text AS status
          , signatures_required, required_roles, signatures
       FROM core.approvals
      WHERE id = $1::uuid
         OR (
           tenant_id = $2::uuid
           AND home_id = $3::uuid
           AND subject_type = $4
           AND subject_id = $5::uuid
         )
      ORDER BY CASE WHEN id = $1::uuid THEN 0 ELSE 1 END
      LIMIT 1`,
    [input.approvalId, input.tenantId, input.homeId, input.subjectType, input.subjectId],
  );

  return result.rows[0];
}

async function applyEmailDraftDecision(
  client: PoolClient,
  decidedByUserId: string,
  decision: 'approved' | 'rejected',
  emailDraftId: string,
): Promise<EmailDraftStatus> {
  const nextStatus: EmailDraftStatus = decision;
  const result = await client.query<EmailDraftStatusRow>(
    `UPDATE core.email_drafts
        SET status = $1::"core"."EmailDraftStatus",
            reviewed_by_user_id = $2::uuid,
            reviewed_at = now(),
            updated_at = now()
      WHERE id = $3::uuid
        AND status = 'needs_review'::"core"."EmailDraftStatus"
      RETURNING status::text AS status`,
    [nextStatus, decidedByUserId, emailDraftId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    const currentStatus = await readEmailDraftStatus(client, emailDraftId);
    if (currentStatus === undefined) {
      throw new Error(`Email draft ${emailDraftId} was not found.`);
    }
    return currentStatus;
  }

  return row.status;
}

async function readEmailDraftStatus(
  client: PoolClient,
  emailDraftId: string,
): Promise<EmailDraftStatus | undefined> {
  const result = await client.query<EmailDraftStatusRow>(
    'SELECT status::text AS status FROM core.email_drafts WHERE id = $1::uuid LIMIT 1',
    [emailDraftId],
  );
  return result.rows[0]?.status;
}

function toCreateResult(row: ExistingApprovalRow): CreateApprovalRequestResult {
  return {
    approvalId: row.id,
    requiredRoles: row.required_roles,
    signatures: parseSignatures(row.signatures),
    signaturesRequired: row.signatures_required,
    status: row.status,
  };
}

function parseSignatures(value: unknown): ApprovalSignature[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isApprovalSignature);
}

function isApprovalSignature(value: unknown): value is ApprovalSignature {
  if (typeof value !== 'object' || value === null) return false;
  const signature = value as Record<string, unknown>;
  return (
    typeof signature.userId === 'string' &&
    (signature.role === 'manager' ||
      signature.role === 'safeguarding_lead' ||
      signature.role === 'ops_admin') &&
    (signature.decision === 'approved' || signature.decision === 'rejected') &&
    typeof signature.decidedAt === 'string'
  );
}

function roleForDecision(
  decision: 'approved' | 'rejected',
  userRoles: readonly string[],
  requiredRoles: readonly ApprovalRole[],
  signatures: readonly ApprovalSignature[],
): ApprovalRole | 'ops_admin' | undefined {
  if (decision === 'rejected') {
    return (
      requiredRoles.find((role) => userRoles.includes(role)) ??
      (userRoles.includes('ops_admin') ? 'ops_admin' : undefined)
    );
  }
  const covered = new Set(
    signatures
      .filter((signature) => signature.decision === 'approved')
      .map((signature) => signature.role),
  );
  return requiredRoles.find((role) => !covered.has(role) && userRoles.includes(role));
}

function terminalStatus(
  row: ApprovalDecisionRow,
  signatures: readonly ApprovalSignature[],
): ApprovalStatus {
  if (signatures.some((signature) => signature.decision === 'rejected')) {
    return 'rejected';
  }
  const approvedRoles = new Set(
    signatures
      .filter((signature) => signature.decision === 'approved')
      .map((signature) => signature.role),
  );
  const covered = row.required_roles.every((role) => approvedRoles.has(role));
  const approvalCount = signatures.filter((signature) => signature.decision === 'approved').length;
  return covered && approvalCount >= row.signatures_required ? 'approved' : 'pending';
}

function resultFor(
  row: ApprovalDecisionRow,
  signatures: readonly ApprovalSignature[],
  status: ApprovalStatus,
): ApplyApprovalDecisionResult {
  return {
    approvalId: row.id,
    requiredRoles: row.required_roles,
    signatures,
    signaturesRequired: row.signatures_required,
    status,
    subjectId: row.subject_id,
    subjectType: row.subject_type,
  };
}

async function terminalResult(
  client: PoolClient,
  row: ApprovalDecisionRow,
): Promise<ApplyApprovalDecisionResult> {
  const result = resultFor(row, parseSignatures(row.signatures), row.status);
  return {
    ...result,
    emailDraftStatus:
      row.subject_type === 'email_draft'
        ? await readEmailDraftStatus(client, row.subject_id)
        : undefined,
    incidentStatus:
      row.subject_type === 'incident'
        ? await readIncidentStatus(client, row.subject_id)
        : undefined,
  };
}

async function readIncidentStatus(
  client: PoolClient,
  incidentId: string,
): Promise<IncidentStatus | undefined> {
  const result = await client.query<{ readonly status: IncidentStatus }>(
    'SELECT status::text AS status FROM core.incidents WHERE id = $1::uuid LIMIT 1',
    [incidentId],
  );
  return result.rows[0]?.status;
}

function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('Unable to derive approval outbox id.');
  }
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}
