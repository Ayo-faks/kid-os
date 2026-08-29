import type { IncidentActor } from '@careos/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
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
  type RetentionWorkflowRuntime,
  WORKFLOW_RUNTIME,
} from '../workflow-runtime/workflow-runtime.port.js';

import {
  TriggerRetentionSweepDto,
  TriggerRetentionSweepSchema,
  UpsertRetentionPolicyDto,
  UpsertRetentionPolicySchema,
  type RetentionPoliciesResponse,
  type RetentionPolicyResponse,
  type RetentionRunsResponse,
} from './dto.js';
import { RetentionService } from './retention.service.js';

@ApiTags('retention')
@UseGuards(RolesGuard)
@Controller('retention')
export class RetentionController {
  constructor(
    @Inject(RetentionService) private readonly retention: RetentionService,
    @Inject(WORKFLOW_RUNTIME) private readonly workflowRuntime: RetentionWorkflowRuntime,
  ) {}

  @Get('policies')
  @Roles('ops_admin')
  @ApiOkResponse({ description: 'Lists retention policies for the active tenant.' })
  async list(@Req() request: FastifyRequest): Promise<RetentionPoliciesResponse> {
    const ctx = this.context(request);
    return this.retention.list(ctx);
  }

  @Get('runs')
  @Roles('ops_admin')
  @ApiOkResponse({ description: 'Lists recent retention sweep runs for the active tenant.' })
  async listRuns(@Req() request: FastifyRequest): Promise<RetentionRunsResponse> {
    return this.retention.listRuns(this.context(request));
  }

  @Put('policies')
  @Roles('ops_admin')
  async upsert(
    @Body(new ZodValidationPipe(UpsertRetentionPolicySchema))
    dto: UpsertRetentionPolicyDto,
    @Req() request: FastifyRequest,
  ): Promise<RetentionPolicyResponse> {
    const ctx = this.context(request);
    return this.retention.upsert(dto, ctx);
  }

  @Post('sweep')
  @HttpCode(202)
  @Roles('ops_admin')
  @ApiAcceptedResponse({ description: 'Starts a manual retention sweep.' })
  async sweep(
    @Body(new ZodValidationPipe(TriggerRetentionSweepSchema))
    dto: TriggerRetentionSweepDto,
    @Req() request: FastifyRequest,
  ): Promise<{ readonly accepted: true; readonly workflowId: string }> {
    if (request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }
    const correlationId = dto.correlationId ?? request.tenant.correlationId;
    const actor: IncidentActor = {
      correlationId,
      kind: 'user',
      userId: request.tenant.actorUserId,
    };
    const started = await this.workflowRuntime.startRetentionSweepWorkflow({
      actor,
      correlationId,
      homeId: request.tenant.homeId,
      nowIso: new Date().toISOString(),
      tenantId: request.tenant.tenantId,
    });
    return { accepted: true, workflowId: started.workflowId };
  }

  private context(request: FastifyRequest) {
    if (request.auth === undefined || request.tenant === undefined) {
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
