import {
  approvalWorkflowId,
  type ApprovalActor,
  type ApprovalDecision,
  type ApprovalRole,
  type ApprovalSignature,
  type ApprovalSubjectType,
} from '@careos/contracts';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  type ApprovalWorkflowRuntime,
  WORKFLOW_RUNTIME,
} from '../workflow-runtime/workflow-runtime.port.js';

import type {
  ApprovalDecisionDto,
  ApprovalDecisionResponse,
  ApprovalQueueItemResponse,
  ApprovalQueueResponse,
} from './dto.js';

interface RequestContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly authorUserId: string;
  readonly correlationId: string;
  readonly actor: ApprovalActor;
  readonly roles: readonly string[];
}

interface ApprovalQueueRow {
  readonly id: string;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly title: string;
  readonly summary: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly requestedByUserId: string;
  readonly createdAt: Date;
  readonly requiredRoles: ApprovalRole[];
  readonly signatures: unknown;
  readonly signaturesRequired: 1 | 2;
  readonly emailRecipientEmail: string | null;
  readonly emailSubject: string | null;
  readonly emailSensitivity: 'routine' | 'sensitive' | null;
  readonly emailStatus: string | null;
  readonly incidentResidentId: string | null;
  readonly incidentResidentName: string | null;
  readonly incidentStatus: string | null;
  readonly incidentTemplateId: string | null;
}

interface ApprovalAuthorizationRow {
  readonly requiredRoles: ApprovalRole[];
  readonly signatures: unknown;
  readonly status: 'pending' | 'approved' | 'rejected';
}

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(WORKFLOW_RUNTIME)
    private readonly workflowRuntime: ApprovalWorkflowRuntime,
  ) {}

  async listPending(context: RequestContext): Promise<ApprovalQueueResponse> {
    const rows = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) => transaction.$queryRaw<ApprovalQueueRow[]>`
        SELECT
          a.id::text AS "id",
          a.subject_type AS "subjectType",
          a.subject_id::text AS "subjectId",
          a.title AS "title",
          a.summary AS "summary",
          a.status::text AS "status",
          a.requested_by_user_id::text AS "requestedByUserId",
          a.created_at AS "createdAt",
          a.required_roles AS "requiredRoles",
          a.signatures AS "signatures",
          a.signatures_required AS "signaturesRequired",
          ed.recipient_email AS "emailRecipientEmail",
          ed.subject AS "emailSubject",
          ed.sensitivity::text AS "emailSensitivity",
          ed.status::text AS "emailStatus"
          ,i.resident_id::text AS "incidentResidentId"
          ,concat_ws(' ', r.preferred_name, r.last_name) AS "incidentResidentName"
          ,i.status::text AS "incidentStatus"
          ,ft.template_id AS "incidentTemplateId"
        FROM core.approvals a
        LEFT JOIN core.email_drafts ed
          ON a.subject_type = 'email_draft'
         AND ed.id = a.subject_id
        LEFT JOIN core.incidents i
          ON a.subject_type = 'incident'
         AND i.id = a.subject_id
        LEFT JOIN core.residents r ON r.id = i.resident_id
        LEFT JOIN core.form_templates ft ON ft.id = i.form_template_id
        WHERE a.status = 'pending'::"core"."ApprovalStatus"
        ORDER BY a.created_at ASC
        LIMIT 100
      `,
    );

    return { items: rows.map((row) => toQueueItem(row, context.authorUserId)) };
  }

  approve(
    approvalId: string,
    dto: ApprovalDecisionDto,
    context: RequestContext,
  ): Promise<ApprovalDecisionResponse> {
    return this.decide(approvalId, 'approved', dto, context);
  }

  async approveIncident(
    incidentId: string,
    dto: ApprovalDecisionDto,
    context: RequestContext,
  ): Promise<ApprovalDecisionResponse> {
    const rows = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) => transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
        FROM core.approvals
        WHERE subject_type = 'incident'
          AND subject_id = ${incidentId}::uuid
        LIMIT 1
      `,
    );
    const approvalId = rows[0]?.id;
    if (approvalId === undefined) {
      throw new NotFoundException(`Approval for incident ${incidentId} not found.`);
    }
    return this.decide(approvalId, 'approved', dto, context);
  }

  reject(
    approvalId: string,
    dto: ApprovalDecisionDto,
    context: RequestContext,
  ): Promise<ApprovalDecisionResponse> {
    return this.decide(approvalId, 'rejected', dto, context);
  }

  private async decide(
    approvalId: string,
    decision: ApprovalDecision,
    dto: ApprovalDecisionDto,
    context: RequestContext,
  ): Promise<ApprovalDecisionResponse> {
    const rows = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) => transaction.$queryRaw<ApprovalAuthorizationRow[]>`
        SELECT
          required_roles AS "requiredRoles",
          signatures,
          status::text AS status
        FROM core.approvals
        WHERE id = ${approvalId}::uuid
        LIMIT 1
      `,
    );
    const approval = rows[0];
    if (approval === undefined) {
      throw new NotFoundException(`Approval ${approvalId} not found.`);
    }
    if (approval.status !== 'pending') {
      throw new ConflictException(`Approval ${approvalId} is already ${approval.status}.`);
    }

    const signatures = parseSignatures(approval.signatures);
    const alreadySigned = signatures.some((signature) => signature.userId === context.authorUserId);
    const coveredRoles = new Set(
      signatures
        .filter((signature) => signature.decision === 'approved')
        .map((signature) => signature.role),
    );
    const outstandingRoles = approval.requiredRoles.filter((role) => !coveredRoles.has(role));
    const coversOutstandingRole = outstandingRoles.some((role) => context.roles.includes(role));
    const canReject =
      approval.requiredRoles.some((role) => context.roles.includes(role)) ||
      context.roles.includes('ops_admin');
    if (!alreadySigned && decision === 'approved' && !coversOutstandingRole) {
      throw new ForbiddenException('Approver does not cover an outstanding required role.');
    }
    if (!alreadySigned && decision === 'rejected' && !canReject) {
      throw new ForbiddenException('Approver is not authorised to reject this approval.');
    }

    await this.workflowRuntime.signalApprovalDecision(
      approvalId,
      {
        actor: context.actor,
        decidedByUserId: context.authorUserId,
        decision,
        reason: dto.reason,
      },
      { homeId: context.homeId, tenantId: context.tenantId },
    );

    return { accepted: true, workflowId: approvalWorkflowId(approvalId) };
  }
}

function toQueueItem(row: ApprovalQueueRow, currentUserId: string): ApprovalQueueItemResponse {
  const signatures = parseSignatures(row.signatures);
  const coveredRoles = row.requiredRoles.filter((role) =>
    signatures.some((signature) => signature.decision === 'approved' && signature.role === role),
  );
  return {
    coveredRoles,
    createdAt: row.createdAt.toISOString(),
    currentUserHasSigned: signatures.some((signature) => signature.userId === currentUserId),
    emailDraft:
      row.emailRecipientEmail !== null &&
      row.emailSubject !== null &&
      row.emailSensitivity !== null &&
      row.emailStatus !== null
        ? {
            recipientEmail: row.emailRecipientEmail,
            sensitivity: row.emailSensitivity,
            status: row.emailStatus,
            subject: row.emailSubject,
          }
        : null,
    id: row.id,
    incident:
      row.incidentResidentId !== null &&
      row.incidentResidentName !== null &&
      row.incidentStatus !== null &&
      row.incidentTemplateId !== null
        ? {
            residentId: row.incidentResidentId,
            residentName: row.incidentResidentName,
            status: row.incidentStatus,
            templateId: row.incidentTemplateId,
          }
        : null,
    requiredRoles: row.requiredRoles,
    requestedByUserId: row.requestedByUserId,
    status: row.status,
    signaturesRecorded: signatures.length,
    signaturesRequired: row.signaturesRequired,
    missingRoles: row.requiredRoles.filter((role) => !coveredRoles.includes(role)),
    signedByUserIds: signatures.map((signature) => signature.userId),
    signedRoles: signatures.map((signature) => signature.role),
    subjectId: row.subjectId,
    subjectType: row.subjectType,
    summary: row.summary,
    title: row.title,
  };
}

function parseSignatures(value: unknown): ApprovalSignature[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ApprovalSignature => {
    if (typeof entry !== 'object' || entry === null) return false;
    const signature = entry as Record<string, unknown>;
    return (
      typeof signature.userId === 'string' &&
      typeof signature.role === 'string' &&
      (signature.decision === 'approved' || signature.decision === 'rejected') &&
      typeof signature.decidedAt === 'string'
    );
  });
}
