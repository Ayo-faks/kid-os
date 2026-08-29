import type { RotaActor } from '@careos/contracts';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import { z } from 'zod';

import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';

import {
  AnalyzeRotaDto,
  AnalyzeRotaSchema,
  CreateRotaRuleDto,
  CreateRotaRuleSchema,
  PublishRotaDto,
  PublishRotaSchema,
} from './dto.js';
import type {
  AnalyzeRotaResponse,
  PublishRotaResponse,
  RotaOverviewResponse,
  RotaRuleResponse,
} from './dto.js';
import { RotaService } from './rota.service.js';

const OverviewRangeSchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((value) => value.from < value.to, {
    message: 'to must be after from.',
    path: ['to'],
  });

export function resolveOverviewRange(
  query: { readonly from?: string; readonly to?: string },
  now = new Date(),
): { readonly from: string; readonly to: string } {
  if (query.from === undefined && query.to === undefined) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return {
      from: from.toISOString(),
      to: new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }
  const parsed = OverviewRangeSchema.safeParse(query);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues);
  return parsed.data;
}

@ApiTags('rota')
@UseGuards(RolesGuard)
@Controller()
export class RotaController {
  constructor(@Inject(RotaService) private readonly rota: RotaService) {}

  @Get('rota')
  @ApiOkResponse({ description: 'List shifts (with assignments) and rota rules for a date range.' })
  async overview(
    @Query() query: { readonly from?: string; readonly to?: string },
    @Req() request: FastifyRequest,
  ): Promise<RotaOverviewResponse> {
    const range = resolveOverviewRange(query);
    const context = this.context(request);
    return this.rota.overview(range.from, range.to, context);
  }

  @Post('rota/analyze')
  @HttpCode(200)
  @ApiOkResponse({
    description: 'Synchronously evaluates rota rules and returns gaps + proposals.',
  })
  async analyze(
    @Body(new ZodValidationPipe(AnalyzeRotaSchema)) dto: AnalyzeRotaDto,
    @Req() request: FastifyRequest,
  ): Promise<AnalyzeRotaResponse> {
    const context = this.context(request);
    return this.rota.analyze(dto, context);
  }

  @Post('rota/publish')
  @HttpCode(202)
  @Roles('manager', 'ops_admin')
  @ApiAcceptedResponse({ description: 'Starts a RotaPublishWorkflow.' })
  async publish(
    @Body(new ZodValidationPipe(PublishRotaSchema)) dto: PublishRotaDto,
    @Req() request: FastifyRequest,
  ): Promise<PublishRotaResponse> {
    const context = this.context(request);
    return this.rota.publish(dto, context);
  }

  @Post('rota/rules')
  @HttpCode(201)
  @Roles('manager', 'ops_admin')
  @ApiOkResponse({ description: 'Creates a new rota rule scoped to the active home.' })
  async createRule(
    @Body(new ZodValidationPipe(CreateRotaRuleSchema)) dto: CreateRotaRuleDto,
    @Req() request: FastifyRequest,
  ): Promise<RotaRuleResponse> {
    const context = this.context(request);
    return this.rota.createRule(dto, context);
  }

  private context(request: FastifyRequest): {
    readonly tenantId: string;
    readonly homeId: string;
    readonly authorUserId: string;
    readonly correlationId: string;
    readonly actor: RotaActor;
  } {
    if (request.auth === undefined || request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }

    const actor: RotaActor = {
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
