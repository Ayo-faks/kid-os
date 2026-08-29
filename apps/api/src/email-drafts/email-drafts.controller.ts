import { type EmailDraftActor } from '@careos/contracts';
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

import {
  CreateEmailDraftDto,
  CreateEmailDraftSchema,
  type CreateEmailDraftResponse,
} from './dto.js';
import { EmailDraftsService } from './email-drafts.service.js';

@ApiTags('email-drafts')
@UseGuards(RolesGuard)
@Controller()
export class EmailDraftsController {
  constructor(@Inject(EmailDraftsService) private readonly emailDrafts: EmailDraftsService) {}

  @Post('comms/email/draft')
  @HttpCode(202)
  @ApiAcceptedResponse({ description: 'Starts an EmailDraftWorkflow.' })
  async create(
    @Body(new ZodValidationPipe(CreateEmailDraftSchema))
    dto: CreateEmailDraftDto,
    @Req() request: FastifyRequest,
  ): Promise<CreateEmailDraftResponse> {
    const context = this.context(request);
    return this.emailDrafts.create(dto, context);
  }

  private context(request: FastifyRequest): {
    readonly tenantId: string;
    readonly homeId: string;
    readonly authorUserId: string;
    readonly correlationId: string;
    readonly actor: EmailDraftActor;
  } {
    if (request.auth === undefined || request.tenant === undefined) {
      throw new UnauthorizedException('Tenant context is missing.');
    }

    const actor: EmailDraftActor = {
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
