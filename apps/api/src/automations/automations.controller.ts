import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';

import { AutomationsService } from './automations.service.js';
import {
  RecentAutomationsQueryDto,
  RecentAutomationsQuerySchema,
  type RecentAutomationsResponse,
} from './dto.js';

@ApiTags('automations')
@UseGuards(RolesGuard)
@Controller('automations')
export class AutomationsController {
  constructor(
    @Inject(AutomationsService)
    private readonly automations: AutomationsService,
  ) {}

  @Get('recent')
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  @ApiOkResponse({
    description: 'Recent scheduled-automation audit events for the active home.',
  })
  async listRecent(
    @Query(new ZodValidationPipe(RecentAutomationsQuerySchema))
    query: RecentAutomationsQueryDto,
    @Req() request: FastifyRequest,
  ): Promise<RecentAutomationsResponse> {
    if (request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }

    return this.automations.listRecent(
      {
        actorUserId: request.tenant.actorUserId,
        correlationId: request.tenant.correlationId,
        homeId: request.tenant.homeId,
        tenantId: request.tenant.tenantId,
      },
      query.limit,
    );
  }
}
