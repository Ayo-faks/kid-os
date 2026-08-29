import { type ApprovalActor } from '@careos/contracts';
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

import { ApprovalsService } from './approvals.service.js';
import {
  ApprovalDecisionDto,
  ApprovalDecisionSchema,
  type ApprovalDecisionResponse,
  type ApprovalQueueResponse,
} from './dto.js';

@ApiTags('approvals')
@UseGuards(RolesGuard)
@Controller()
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  @Get('approvals')
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  @ApiOkResponse({ description: 'Pending approval queue for the active home.' })
  async list(@Req() request: FastifyRequest): Promise<ApprovalQueueResponse> {
    const context = this.context(request);
    return this.approvals.listPending(context);
  }

  @Post('approvals/:id/approve')
  @HttpCode(202)
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  @ApiAcceptedResponse({ description: 'Signals the approval workflow to approve.' })
  async approve(
    @Param('id', new ParseUUIDPipe({ version: '4' })) approvalId: string,
    @Body(new ZodValidationPipe(ApprovalDecisionSchema)) dto: ApprovalDecisionDto,
    @Req() request: FastifyRequest,
  ): Promise<ApprovalDecisionResponse> {
    const context = this.context(request);
    return this.approvals.approve(approvalId, dto, context);
  }

  @Post('approvals/:id/reject')
  @HttpCode(202)
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  @ApiAcceptedResponse({ description: 'Signals the approval workflow to reject.' })
  async reject(
    @Param('id', new ParseUUIDPipe({ version: '4' })) approvalId: string,
    @Body(new ZodValidationPipe(ApprovalDecisionSchema)) dto: ApprovalDecisionDto,
    @Req() request: FastifyRequest,
  ): Promise<ApprovalDecisionResponse> {
    const context = this.context(request);
    return this.approvals.reject(approvalId, dto, context);
  }

  private context(request: FastifyRequest): {
    readonly tenantId: string;
    readonly homeId: string;
    readonly authorUserId: string;
    readonly correlationId: string;
    readonly roles: readonly string[];
    readonly actor: ApprovalActor;
  } {
    if (request.auth === undefined || request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }

    const actor: ApprovalActor = {
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
