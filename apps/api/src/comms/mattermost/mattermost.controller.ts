import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Public } from '../../common/public.decorator.js';
import { Roles } from '../../common/roles.decorator.js';
import { RolesGuard } from '../../common/roles.guard.js';

import {
  ExchangeLinkCodeDto,
  ExchangeLinkCodeSchema,
  IssueLinkCodeDto,
  IssueLinkCodeSchema,
  UpsertChannelMappingDto,
  UpsertChannelMappingSchema,
  type ChannelMappingResponse,
  type ExchangeLinkCodeResponse,
  type IssueLinkCodeResponse,
  type ListChannelMappingsResponse,
} from './dto.js';
import { MattermostService } from './mattermost.service.js';

@ApiTags('comms.mattermost')
@UseGuards(RolesGuard)
@Controller('comms/mattermost')
export class MattermostController {
  constructor(@Inject(MattermostService) private readonly mattermost: MattermostService) {}

  @Post('link-codes')
  @HttpCode(201)
  @ApiCreatedResponse({ description: 'Issues a one-time /link code.' })
  async issue(
    @Body(new ZodValidationPipe(IssueLinkCodeSchema)) dto: IssueLinkCodeDto,
    @Req() request: FastifyRequest,
  ): Promise<IssueLinkCodeResponse> {
    if (request.auth === undefined || request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }

    return this.mattermost.issueLinkCode(dto, {
      correlationId: request.tenant.correlationId,
      homeId: request.tenant.homeId,
      tenantId: request.tenant.tenantId,
      userId: request.tenant.actorUserId,
    });
  }

  @Post('link-codes/exchange')
  @Public()
  @HttpCode(200)
  @ApiOkResponse({ description: 'Exchanges a /link code for a linked identity.' })
  async exchange(
    @Body(new ZodValidationPipe(ExchangeLinkCodeSchema)) dto: ExchangeLinkCodeDto,
    @Headers('x-careos-mattermost-bot-token') botToken: string | undefined,
  ): Promise<ExchangeLinkCodeResponse> {
    return this.mattermost.exchangeLinkCode(dto, botToken);
  }

  @Get('channels')
  @Roles('manager', 'ops_admin')
  @ApiOkResponse({ description: 'Lists Mattermost channel mappings for the active home.' })
  async listChannels(@Req() request: FastifyRequest): Promise<ListChannelMappingsResponse> {
    if (request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }
    return this.mattermost.listChannelMappings({
      actorUserId: request.tenant.actorUserId,
      correlationId: request.tenant.correlationId,
      homeId: request.tenant.homeId,
      tenantId: request.tenant.tenantId,
    });
  }

  @Post('channels')
  @HttpCode(201)
  @Roles('manager', 'ops_admin')
  @ApiCreatedResponse({ description: 'Upserts a Mattermost channel mapping by kind.' })
  async upsertChannel(
    @Body(new ZodValidationPipe(UpsertChannelMappingSchema)) dto: UpsertChannelMappingDto,
    @Req() request: FastifyRequest,
  ): Promise<ChannelMappingResponse> {
    if (request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }
    return this.mattermost.upsertChannelMapping(dto, {
      actorUserId: request.tenant.actorUserId,
      correlationId: request.tenant.correlationId,
      homeId: request.tenant.homeId,
      tenantId: request.tenant.tenantId,
    });
  }
}
