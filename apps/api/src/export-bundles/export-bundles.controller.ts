import { type IncidentActor } from '@careos/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';

import {
  RequestExportBundleDto,
  RequestExportBundleSchema,
  type ExportBundleDownloadResponse,
  type ExportBundleResponse,
  type RequestExportBundleResponse,
} from './dto.js';
import { ExportBundlesService } from './export-bundles.service.js';

@ApiTags('export-bundles')
@UseGuards(RolesGuard)
@Controller('export-bundles')
export class ExportBundlesController {
  constructor(@Inject(ExportBundlesService) private readonly bundles: ExportBundlesService) {}

  @Post()
  @HttpCode(202)
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  @ApiAcceptedResponse({ description: 'Requests a serious incident export bundle.' })
  async request(
    @Body(new ZodValidationPipe(RequestExportBundleSchema)) dto: RequestExportBundleDto,
    @Req() request: FastifyRequest,
  ): Promise<RequestExportBundleResponse> {
    const context = this.context(request);
    return this.bundles.request(dto, context);
  }

  @Get(':id')
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  @ApiOkResponse({ description: 'Returns an export bundle record by id.' })
  async findById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ): Promise<ExportBundleResponse> {
    const context = this.context(request);
    return this.bundles.findById(id, context);
  }

  @Get(':id/download')
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  @ApiOkResponse({
    description: 'Returns a short-lived presigned download URL for a ready bundle.',
  })
  async download(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ): Promise<ExportBundleDownloadResponse> {
    const context = this.context(request);
    return this.bundles.presignDownload(id, context);
  }

  private context(request: FastifyRequest) {
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
      correlationId: request.tenant.correlationId,
      homeId: request.tenant.homeId,
      requestedByUserId: request.tenant.actorUserId,
      tenantId: request.tenant.tenantId,
    };
  }
}
