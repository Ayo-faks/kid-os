import { type ApprovalActor, type IncidentActor } from '@careos/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';

import { ApprovalsService } from '../approvals/approvals.service.js';
import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';

import {
  ApproveIncidentDto,
  CreateIncidentDto,
  DraftIncidentFromTextDto,
  ExportIncidentDto,
  SubmitIncidentDto,
  UpdateIncidentDto,
  type CreateIncidentResponse,
  type DraftIncidentFromTextResponse,
  type IncidentDetailResponse,
  type IncidentListResponse,
  type TimelineEntryResponse,
} from './dto.js';
import { IncidentsService } from './incidents.service.js';

@ApiTags('incidents')
@UseGuards(RolesGuard)
@Controller()
export class IncidentsController {
  constructor(
    @Inject(IncidentsService) private readonly incidents: IncidentsService,
    @Inject(ApprovalsService) private readonly approvals: ApprovalsService,
  ) {}

  @Post('incidents/draft-from-text')
  @HttpCode(200)
  @ApiOkResponse({ description: 'Returns a schema-gated incident draft for staff review.' })
  draftFromText(
    @Body() dto: DraftIncidentFromTextDto,
    @Req() request: FastifyRequest,
  ): Promise<DraftIncidentFromTextResponse> {
    return this.incidents.draftFromText(dto, this.context(request));
  }

  @Post('incidents')
  @HttpCode(202)
  @ApiAcceptedResponse({ description: 'Starts an IncidentReportWorkflow.' })
  async create(
    @Body() dto: CreateIncidentDto,
    @Req() request: FastifyRequest,
  ): Promise<CreateIncidentResponse> {
    const context = this.context(request);
    return this.incidents.create(dto, context);
  }

  @Get('incidents')
  @ApiOkResponse({ description: 'Lists active incidents for the current home.' })
  list(@Req() request: FastifyRequest): Promise<IncidentListResponse> {
    return this.incidents.list(this.context(request));
  }

  @Patch('incidents/:id')
  @HttpCode(202)
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) incidentId: string,
    @Body() dto: UpdateIncidentDto,
    @Req() request: FastifyRequest,
  ): Promise<{ readonly accepted: true; readonly workflowId: string }> {
    const context = this.context(request);
    return this.incidents.update(incidentId, dto, context);
  }

  @Post('incidents/:id/submit')
  @HttpCode(202)
  async submit(
    @Param('id', new ParseUUIDPipe({ version: '4' })) incidentId: string,
    @Body() _dto: SubmitIncidentDto,
    @Req() request: FastifyRequest,
  ): Promise<{ readonly accepted: true; readonly workflowId: string }> {
    const context = this.context(request);
    return this.incidents.submit(incidentId, context);
  }

  @Post('incidents/:id/approve')
  @HttpCode(202)
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  async approve(
    @Param('id', new ParseUUIDPipe({ version: '4' })) incidentId: string,
    @Body() dto: ApproveIncidentDto,
    @Req() request: FastifyRequest,
  ): Promise<{ readonly accepted: true; readonly workflowId: string }> {
    const context = this.context(request);
    const actor: ApprovalActor = {
      correlationId: context.correlationId,
      kind: 'user',
      userId: context.authorUserId,
    };
    return this.approvals.approveIncident(
      incidentId,
      { reason: dto.note },
      {
        actor,
        authorUserId: context.authorUserId,
        correlationId: context.correlationId,
        homeId: context.homeId,
        roles: context.roles,
        tenantId: context.tenantId,
      },
    );
  }

  @Post('incidents/:id/export')
  @HttpCode(202)
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  async export(
    @Param('id', new ParseUUIDPipe({ version: '4' })) incidentId: string,
    @Body() _dto: ExportIncidentDto,
    @Req() request: FastifyRequest,
  ): Promise<{ readonly accepted: true; readonly workflowId: string }> {
    const context = this.context(request);
    return this.incidents.exportPdf(incidentId, context);
  }

  @Get('incidents/:id/download')
  @Roles('manager', 'safeguarding_lead', 'ops_admin', 'support_worker')
  @ApiOkResponse({ description: 'Presigned MinIO URL for the exported PDF.' })
  async download(
    @Param('id', new ParseUUIDPipe({ version: '4' })) incidentId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ readonly url: string; readonly expiresInSeconds: number }> {
    return this.incidents.presignedDownloadUrl(incidentId, this.context(request));
  }

  @Get('incidents/:id')
  @ApiOkResponse({ description: 'Incident with versions and timeline.' })
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) incidentId: string,
    @Req() request: FastifyRequest,
  ): Promise<IncidentDetailResponse> {
    return this.incidents.findById(incidentId, this.context(request));
  }

  @Get('residents/:id/timeline')
  async residentTimeline(
    @Param('id', new ParseUUIDPipe({ version: '4' })) residentId: string,
    @Req() request: FastifyRequest,
  ): Promise<readonly TimelineEntryResponse[]> {
    return this.incidents.listResidentTimeline(residentId, this.context(request));
  }

  private context(request: FastifyRequest): {
    readonly tenantId: string;
    readonly homeId: string;
    readonly authorUserId: string;
    readonly correlationId: string;
    readonly roles: readonly string[];
    readonly actor: IncidentActor;
  } {
    if (request.auth === undefined || request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }

    const actor: IncidentActor = {
      correlationId: request.tenant.correlationId,
      kind: 'user',
      userId: request.tenant.actorUserId,
    };

    return {
      actor,
      authorUserId: request.tenant.actorUserId,
      correlationId: request.tenant.correlationId,
      homeId: request.tenant.homeId,
      roles: request.tenant.roles,
      tenantId: request.tenant.tenantId,
    };
  }
}
