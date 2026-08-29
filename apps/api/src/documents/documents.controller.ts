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

import { DocumentsService } from './documents.service.js';
import {
  PresignDocumentDto,
  PresignDocumentSchema,
  RegisterDocumentDto,
  RegisterDocumentSchema,
  type DocumentResponse,
  type DocumentListResponse,
  type PresignDocumentResponse,
  type RegisterDocumentResponse,
} from './dto.js';

@ApiTags('documents')
@UseGuards(RolesGuard)
@Controller('documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  @Post('presign')
  @HttpCode(200)
  @Roles('manager', 'safeguarding_lead', 'support_worker', 'ops_admin')
  @ApiOkResponse({ description: 'Returns a scoped short-lived document upload URL.' })
  async presign(
    @Body(new ZodValidationPipe(PresignDocumentSchema)) dto: PresignDocumentDto,
    @Req() request: FastifyRequest,
  ): Promise<PresignDocumentResponse> {
    return this.documents.presign(dto, this.context(request));
  }

  @Post()
  @HttpCode(202)
  @Roles('manager', 'safeguarding_lead', 'support_worker', 'ops_admin')
  @ApiAcceptedResponse({ description: 'Registers a document and starts ingestion.' })
  async register(
    @Body(new ZodValidationPipe(RegisterDocumentSchema)) dto: RegisterDocumentDto,
    @Req() request: FastifyRequest,
  ): Promise<RegisterDocumentResponse> {
    const context = this.context(request);
    return this.documents.register(dto, context);
  }

  @Get()
  @Roles('manager', 'safeguarding_lead', 'support_worker', 'ops_admin')
  @ApiOkResponse({ description: 'Lists the latest documents for the active home.' })
  list(@Req() request: FastifyRequest): Promise<DocumentListResponse> {
    return this.documents.list(this.context(request));
  }

  @Get(':id')
  @Roles('manager', 'safeguarding_lead', 'support_worker', 'ops_admin')
  @ApiOkResponse({ description: 'Returns a document record by id.' })
  async findById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() request: FastifyRequest,
  ): Promise<DocumentResponse> {
    const context = this.context(request);
    return this.documents.findById(id, context);
  }

  private context(request: FastifyRequest): {
    readonly tenantId: string;
    readonly homeId: string;
    readonly uploaderUserId: string;
    readonly correlationId: string;
    readonly actor: IncidentActor;
  } {
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
      tenantId: request.tenant.tenantId,
      uploaderUserId: request.tenant.actorUserId,
    };
  }
}
