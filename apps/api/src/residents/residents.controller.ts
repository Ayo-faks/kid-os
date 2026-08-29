import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import type { ListResidentsResponse, ResidentResponse } from './dto.js';
import { ResidentsService } from './residents.service.js';

@ApiTags('residents')
@Controller('residents')
export class ResidentsController {
  constructor(@Inject(ResidentsService) private readonly residents: ResidentsService) {}

  @Get()
  @ApiOkResponse({ description: 'List residents in scope of the active home.' })
  list(@Req() request: FastifyRequest): Promise<ListResidentsResponse> {
    return this.residents.list(this.context(request));
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Resident detail.' })
  findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) residentId: string,
    @Req() request: FastifyRequest,
  ): Promise<ResidentResponse> {
    return this.residents.findById(residentId, this.context(request));
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
