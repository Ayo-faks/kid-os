import { type HandoverActor } from '@careos/contracts';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { RolesGuard } from '../common/roles.guard.js';

import { CreateHandoverDto, CreateHandoverSchema, type CreateHandoverResponse } from './dto.js';
import { HandoversService } from './handovers.service.js';

@ApiTags('handovers')
@UseGuards(RolesGuard)
@Controller()
export class HandoversController {
  constructor(@Inject(HandoversService) private readonly handovers: HandoversService) {}

  @Post('handovers')
  @HttpCode(202)
  @ApiAcceptedResponse({ description: 'Starts a HandoverWorkflow.' })
  async create(
    @Body(new ZodValidationPipe(CreateHandoverSchema)) dto: CreateHandoverDto,
    @Req() request: FastifyRequest,
  ): Promise<CreateHandoverResponse> {
    const context = this.context(request);
    return this.handovers.create(dto, context);
  }

  private context(request: FastifyRequest): {
    readonly tenantId: string;
    readonly homeId: string;
    readonly authorUserId: string;
    readonly correlationId: string;
    readonly actor: HandoverActor;
  } {
    if (request.auth === undefined || request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }

    const actor: HandoverActor = {
      correlationId: request.tenant.correlationId,
      kind: 'user',
      userId: request.tenant.actorUserId,
    };

    return {
      actor,
      authorUserId: request.tenant.actorUserId,
      correlationId: request.tenant.correlationId,
      homeId: request.tenant.homeId,
      tenantId: request.tenant.tenantId,
    };
  }
}
