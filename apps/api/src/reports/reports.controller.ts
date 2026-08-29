import type { IncidentReportResponse } from '@careos/contracts';
import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';

import { ReportFiltersDto, ReportFiltersSchema, ReportGroupBySchema } from './dto.js';
import { ReportsService } from './reports.service.js';

@ApiTags('reports')
@UseGuards(RolesGuard)
@Controller('reports/incidents')
export class ReportsController {
  constructor(
    @Inject(ReportsService)
    private readonly reports: ReportsService,
  ) {}

  @Get('by-type')
  @Roles('support_worker', 'key_worker', 'shift_lead', 'manager', 'safeguarding_lead', 'ops_admin')
  @ApiOkResponse({ description: 'Incidents grouped by `incident_type`.' })
  async byType(
    @Query(new ZodValidationPipe(ReportFiltersSchema)) filters: ReportFiltersDto,
    @Req() request: FastifyRequest,
  ): Promise<IncidentReportResponse> {
    return this.reports.incidentsAggregate(this.context(request), 'type', filters);
  }

  @Get('by-home')
  @Roles('support_worker', 'key_worker', 'shift_lead', 'manager', 'safeguarding_lead', 'ops_admin')
  async byHome(
    @Query(new ZodValidationPipe(ReportFiltersSchema)) filters: ReportFiltersDto,
    @Req() request: FastifyRequest,
  ): Promise<IncidentReportResponse> {
    return this.reports.incidentsAggregate(this.context(request), 'home', filters);
  }

  @Get('by-month')
  @Roles('support_worker', 'key_worker', 'shift_lead', 'manager', 'safeguarding_lead', 'ops_admin')
  async byMonth(
    @Query(new ZodValidationPipe(ReportFiltersSchema)) filters: ReportFiltersDto,
    @Req() request: FastifyRequest,
  ): Promise<IncidentReportResponse> {
    return this.reports.incidentsAggregate(this.context(request), 'month', filters);
  }

  @Get('export.csv')
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  async exportCsv(
    @Query(new ZodValidationPipe(ReportGroupBySchema))
    query: { groupBy: 'type' | 'home' | 'month'; from?: string; to?: string },
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const csv = await this.reports.incidentsAggregateCsv(this.context(request), query.groupBy, {
      from: query.from,
      to: query.to,
    });
    void reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="incidents-by-${query.groupBy}.csv"`)
      .send(csv);
  }

  private context(request: FastifyRequest) {
    if (request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }
    return {
      actorUserId: request.tenant.actorUserId,
      correlationId: request.tenant.correlationId,
      homeId: request.tenant.homeId,
      tenantId: request.tenant.tenantId,
    };
  }
}
