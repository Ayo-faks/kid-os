// Phase 1 §4: Incidents controller surface.
//
// Hard rules from the brief:
// - All writes go through Temporal as workflow signals/queries — never direct
//   DB mutation here. The controller starts the workflow and dispatches
//   signals; the workflow itself owns DB persistence (Phase 1 §5).
// - Every database read/preflight runs inside PrismaService.withTenantContext;
//   the guard only resolves identity + scope and never mutates pooled sessions.

import { randomUUID } from 'node:crypto';

import { incidentWorkflowId, type IncidentActor } from '@careos/contracts';
import { findFormTemplate, validatePartialFormData } from '@careos/schemas';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import {
  type IncidentWorkflowRuntime,
  WORKFLOW_RUNTIME,
} from '../workflow-runtime/workflow-runtime.port.js';

import {
  type CreateIncidentDto,
  type CreateIncidentResponse,
  type DraftIncidentFromTextDto,
  type DraftIncidentFromTextResponse,
  type IncidentDetailResponse,
  type IncidentListResponse,
  type IncidentVersionResponse,
  type TimelineEntryResponse,
  type UpdateIncidentDto,
} from './dto.js';

interface RequestContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly authorUserId: string;
  readonly correlationId: string;
  readonly actor: IncidentActor;
}

@Injectable()
export class IncidentsService {
  private readonly hermesUrl = process.env.HERMES_URL ?? 'http://hermes:8080';

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(WORKFLOW_RUNTIME)
    private readonly workflowRuntime: IncidentWorkflowRuntime,
    @Inject(StorageService)
    private readonly storage: StorageService,
  ) {}

  async draftFromText(
    dto: DraftIncidentFromTextDto,
    context: RequestContext,
  ): Promise<DraftIncidentFromTextResponse> {
    if (findFormTemplate(dto.template_id, 'v1') === undefined) {
      throw new BadRequestException(`Unknown form template ${dto.template_id}@v1.`);
    }

    const references = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      async (transaction) => {
        const [template, resident] = await Promise.all([
          transaction.formTemplate.findFirst({
            select: { id: true },
            where: {
              retiredAt: null,
              templateId: dto.template_id,
              tenantId: context.tenantId,
              version: 'v1',
            },
          }),
          transaction.resident.findFirst({
            select: { id: true },
            where: {
              homeId: context.homeId,
              id: dto.resident_id,
              OR: [{ leftAt: null }, { leftAt: { gt: new Date() } }],
              tenantId: context.tenantId,
            },
          }),
        ]);
        return { resident, template };
      },
    );

    if (references.template === null) {
      throw new BadRequestException(`Form template ${dto.template_id}@v1 is not registered.`);
    }
    if (references.resident === null) {
      throw new NotFoundException(`Resident ${dto.resident_id} not found in the active home.`);
    }

    let response: Response;
    try {
      response = await fetch(new URL('/mcp', this.hermesUrl), {
        body: JSON.stringify({
          id: randomUUID(),
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            arguments: {
              correlation_id: context.correlationId,
              free_text: dto.free_text,
              resident_id: dto.resident_id,
              template_id: dto.template_id,
            },
            name: 'draft_incident_from_text',
          },
        }),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-careos-correlation-id': context.correlationId,
          'x-careos-home-id': context.homeId,
          'x-careos-tenant-id': context.tenantId,
          'x-careos-user-id': context.authorUserId,
        },
        method: 'POST',
      });
    } catch {
      throw new ServiceUnavailableException('Incident drafting is temporarily unavailable.');
    }

    if (!response.ok) {
      throw new ServiceUnavailableException('Incident drafting is temporarily unavailable.');
    }

    const draft = extractHermesDraft(await response.json());
    if (draft === null) {
      throw new ServiceUnavailableException('Incident drafting returned an invalid response.');
    }
    return draft;
  }

  async create(dto: CreateIncidentDto, context: RequestContext): Promise<CreateIncidentResponse> {
    if (findFormTemplate(dto.formTemplate.templateId, dto.formTemplate.version) === undefined) {
      throw new BadRequestException(
        `Unknown form template ${dto.formTemplate.templateId}@${dto.formTemplate.version}.`,
      );
    }

    if (
      dto.initialFormData?.residentId !== undefined &&
      dto.initialFormData.residentId !== dto.residentId
    ) {
      throw new BadRequestException('Initial form residentId must match the selected resident.');
    }
    const initialFormData = { ...(dto.initialFormData ?? {}), residentId: dto.residentId };
    const initialValidation = validatePartialFormData(
      dto.formTemplate.templateId,
      dto.formTemplate.version,
      initialFormData,
    );
    if (!initialValidation.valid) {
      throw new BadRequestException({
        errors: initialValidation.errors,
        message: 'Initial form data failed schema validation.',
      });
    }

    const preflight = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      async (transaction) => {
        const [template, resident] = await Promise.all([
          transaction.formTemplate.findFirst({
            select: { id: true },
            where: {
              retiredAt: null,
              templateId: dto.formTemplate.templateId,
              tenantId: context.tenantId,
              version: dto.formTemplate.version,
            },
          }),
          transaction.resident.findFirst({
            select: { id: true },
            where: {
              homeId: context.homeId,
              id: dto.residentId,
              OR: [{ leftAt: null }, { leftAt: { gt: new Date() } }],
              tenantId: context.tenantId,
            },
          }),
        ]);
        return { resident, template };
      },
    );

    if (preflight.template === null) {
      throw new BadRequestException(
        `Form template ${dto.formTemplate.templateId}@${dto.formTemplate.version} is not registered.`,
      );
    }
    if (preflight.resident === null) {
      throw new NotFoundException(`Resident ${dto.residentId} not found in the active home.`);
    }

    const incidentId = randomUUID();
    const started = await this.workflowRuntime.startIncidentReportWorkflow({
      authorUserId: context.authorUserId,
      correlationId: context.correlationId,
      formTemplate: dto.formTemplate,
      homeId: context.homeId,
      incidentId,
      initialFormData,
      residentId: dto.residentId,
      tenantId: context.tenantId,
    });

    return {
      id: started.incidentId,
      status: 'draft',
      workflowId: started.workflowId,
    };
  }

  async update(
    incidentId: string,
    dto: UpdateIncidentDto,
    context: RequestContext,
  ): Promise<{ readonly accepted: true; readonly workflowId: string }> {
    const incident = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) =>
        transaction.incident.findFirst({
          select: {
            formTemplate: { select: { templateId: true, version: true } },
            residentId: true,
          },
          where: { id: incidentId, softDeletedAt: null },
        }),
    );
    if (incident === null) {
      throw new NotFoundException(`Incident ${incidentId} not found.`);
    }
    if (dto.formData.residentId !== undefined && dto.formData.residentId !== incident.residentId) {
      throw new BadRequestException('Form residentId cannot be changed.');
    }

    const formData = { ...dto.formData, residentId: incident.residentId };
    const validation = validatePartialFormData(
      incident.formTemplate.templateId,
      incident.formTemplate.version,
      formData,
    );
    if (!validation.valid) {
      throw new BadRequestException({
        errors: validation.errors,
        message: 'Form data failed schema validation.',
      });
    }

    await this.workflowRuntime.signalUpdateDraft(
      incidentId,
      {
        actor: context.actor,
        formData,
      },
      { homeId: context.homeId, tenantId: context.tenantId },
    );

    return { accepted: true, workflowId: incidentWorkflowId(incidentId) };
  }

  async submit(
    incidentId: string,
    context: RequestContext,
  ): Promise<{ readonly accepted: true; readonly workflowId: string }> {
    await this.workflowRuntime.signalSubmitForApproval(
      incidentId,
      { actor: context.actor },
      { homeId: context.homeId, tenantId: context.tenantId },
    );
    return { accepted: true, workflowId: incidentWorkflowId(incidentId) };
  }

  async exportPdf(
    incidentId: string,
    context: RequestContext,
  ): Promise<{ readonly accepted: true; readonly workflowId: string }> {
    const incident = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) =>
        transaction.incident.findFirst({
          select: { status: true },
          where: { id: incidentId, softDeletedAt: null },
        }),
    );
    if (incident === null) {
      throw new NotFoundException(`Incident ${incidentId} not found.`);
    }
    if (incident.status !== 'approved') {
      throw new ConflictException('Only approved incidents can be exported.');
    }

    await this.workflowRuntime.signalExport(
      incidentId,
      { actor: context.actor },
      { homeId: context.homeId, tenantId: context.tenantId },
    );
    return { accepted: true, workflowId: incidentWorkflowId(incidentId) };
  }

  async presignedDownloadUrl(
    incidentId: string,
    context: RequestContext,
  ): Promise<{ readonly url: string; readonly expiresInSeconds: number }> {
    const incident = await this.prisma.withTenantContext(
      {
        actor: context.actor,
        homeId: context.homeId,
        tenantId: context.tenantId,
      },
      (transaction) =>
        transaction.incident.findFirst({
          select: { exportObjectKey: true, status: true },
          where: { id: incidentId, softDeletedAt: null },
        }),
    );
    if (incident === null) {
      throw new NotFoundException(`Incident ${incidentId} not found.`);
    }
    if (incident.exportObjectKey === null || incident.status !== 'exported') {
      throw new NotFoundException(`Incident ${incidentId} has not been exported yet.`);
    }
    const expiresInSeconds = 300;
    const url = await this.storage.presignedIncidentDownload(
      incident.exportObjectKey,
      expiresInSeconds,
    );
    return { expiresInSeconds, url };
  }

  async findById(incidentId: string, context: RequestContext): Promise<IncidentDetailResponse> {
    const detail = await this.prisma.withTenantContext(
      {
        actor: context.actor,
        homeId: context.homeId,
        tenantId: context.tenantId,
      },
      async (transaction) => {
        const incident = await transaction.incident.findFirst({
          include: {
            formTemplate: true,
            resident: true,
            exportBundles: {
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
            timeline: {
              orderBy: { occurredAt: 'desc' },
              take: 100,
            },
            versions: {
              orderBy: { version: 'asc' },
            },
          },
          where: { id: incidentId, softDeletedAt: null },
        });
        if (incident === null) return null;
        const approval = await transaction.approval.findFirst({
          select: {
            id: true,
            requiredRoles: true,
            signatures: true,
            signaturesRequired: true,
            status: true,
          },
          where: { subjectId: incidentId, subjectType: 'incident' },
        });
        return { approval, incident };
      },
    );

    if (detail === null) {
      throw new NotFoundException(`Incident ${incidentId} not found.`);
    }
    const { approval, incident } = detail;
    const signatures = parseApprovalSignatures(approval?.signatures);
    const requiredRoles = (approval?.requiredRoles ?? []) as ('manager' | 'safeguarding_lead')[];
    const coveredRoles = requiredRoles.filter((role) =>
      signatures.some((signature) => signature.decision === 'approved' && signature.role === role),
    );

    return {
      approval:
        approval === null
          ? null
          : {
              id: approval.id,
              coveredRoles,
              missingRoles: requiredRoles.filter((role) => !coveredRoles.includes(role)),
              requiredRoles,
              signaturesRecorded: signatures.length,
              signaturesRequired: approval.signaturesRequired as 1 | 2,
              signedByUserIds: signatures.map((signature) => signature.userId),
              signedRoles: signatures.map((signature) => signature.role),
              status: approval.status,
            },
      approvedAt: incident.approvedAt?.toISOString() ?? null,
      approvedByUserId: incident.approvedByUserId,
      authorUserId: incident.authorUserId,
      createdAt: incident.createdAt.toISOString(),
      currentVersion: incident.currentVersion,
      exportBundle:
        incident.exportBundles[0] === undefined
          ? null
          : {
              createdAt: incident.exportBundles[0].createdAt.toISOString(),
              failureReason: incident.exportBundles[0].failureReason,
              id: incident.exportBundles[0].id,
              sizeBytes: incident.exportBundles[0].sizeBytes,
              status: incident.exportBundles[0].status,
              updatedAt: incident.exportBundles[0].updatedAt.toISOString(),
            },
      exportedAt: incident.exportedAt?.toISOString() ?? null,
      id: incident.id,
      formTemplate: {
        templateId: incident.formTemplate.templateId,
        title: incident.formTemplate.title,
        version: incident.formTemplate.version,
      },
      residentId: incident.residentId,
      residentName: `${incident.resident.preferredName ?? incident.resident.firstName} ${incident.resident.lastName}`,
      status: incident.status,
      timeline: incident.timeline.map(toTimelineEntryResponse),
      updatedAt: incident.updatedAt.toISOString(),
      versions: incident.versions.map(toVersionResponse),
      workflowId: incident.workflowId ?? incidentWorkflowId(incident.id),
    };
  }

  async list(context: RequestContext): Promise<IncidentListResponse> {
    const incidents = await this.prisma.withTenantContext(
      { actor: context.actor, homeId: context.homeId, tenantId: context.tenantId },
      (transaction) =>
        transaction.incident.findMany({
          include: { formTemplate: true, resident: true },
          orderBy: { updatedAt: 'desc' },
          take: 200,
          where: { softDeletedAt: null },
        }),
    );
    return {
      items: incidents.map((incident) => ({
        createdAt: incident.createdAt.toISOString(),
        currentVersion: incident.currentVersion,
        id: incident.id,
        residentId: incident.residentId,
        residentName: `${incident.resident.preferredName ?? incident.resident.firstName} ${incident.resident.lastName}`,
        status: incident.status,
        templateId: incident.formTemplate.templateId,
        templateTitle: incident.formTemplate.title,
        updatedAt: incident.updatedAt.toISOString(),
      })),
    };
  }

  async listResidentTimeline(
    residentId: string,
    context: RequestContext,
  ): Promise<readonly TimelineEntryResponse[]> {
    const entries = await this.prisma.withTenantContext(
      {
        actor: context.actor,
        homeId: context.homeId,
        tenantId: context.tenantId,
      },
      (transaction) =>
        transaction.timelineEntry.findMany({
          orderBy: { occurredAt: 'desc' },
          take: 200,
          where: {
            OR: [{ incidentId: null }, { incident: { softDeletedAt: null } }],
            residentId,
          },
        }),
    );

    return entries.map(toTimelineEntryResponse);
  }
}

function extractHermesDraft(value: unknown): DraftIncidentFromTextResponse | null {
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.content)) {
    return null;
  }
  const text = value.result.content.find(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item.type === 'text' && typeof item.text === 'string',
  )?.text;
  if (typeof text !== 'string') return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (
      !isRecord(parsed) ||
      typeof parsed.confidence !== 'number' ||
      !isRecord(parsed.form_data) ||
      !Array.isArray(parsed.missing_mandatory) ||
      !parsed.missing_mandatory.every((item) => typeof item === 'string')
    ) {
      return null;
    }
    return {
      confidence: parsed.confidence,
      form_data: parsed.form_data,
      missing_mandatory: parsed.missing_mandatory,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseApprovalSignatures(value: unknown): Array<{
  readonly decision: 'approved' | 'rejected';
  readonly role: string;
  readonly userId: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const signature = entry as Record<string, unknown>;
    return typeof signature.role === 'string' &&
      typeof signature.userId === 'string' &&
      (signature.decision === 'approved' || signature.decision === 'rejected')
      ? [{ decision: signature.decision, role: signature.role, userId: signature.userId }]
      : [];
  });
}

function toVersionResponse(version: {
  readonly version: number;
  readonly status: string;
  readonly formData: unknown;
  readonly missingMandatory: readonly string[];
  readonly validationErrors: unknown;
  readonly actorKind: string;
  readonly actorUserId: string | null;
  readonly createdAt: Date;
}): IncidentVersionResponse {
  return {
    actorKind: version.actorKind,
    actorUserId: version.actorUserId,
    createdAt: version.createdAt.toISOString(),
    formData: (version.formData ?? {}) as Record<string, unknown>,
    missingMandatory: version.missingMandatory,
    status: version.status,
    validationErrors: version.validationErrors,
    version: version.version,
  };
}

function toTimelineEntryResponse(entry: {
  readonly id: string;
  readonly kind: string;
  readonly occurredAt: Date;
  readonly summary: string;
  readonly payload: unknown;
  readonly incidentId: string | null;
  readonly taskId: string | null;
  readonly actorKind: string;
  readonly actorUserId: string | null;
}): TimelineEntryResponse {
  return {
    actorKind: entry.actorKind,
    actorUserId: entry.actorUserId,
    id: entry.id,
    incidentId: entry.incidentId,
    kind: entry.kind,
    occurredAt: entry.occurredAt.toISOString(),
    payload: entry.payload,
    summary: entry.summary,
    taskId: entry.taskId,
  };
}
