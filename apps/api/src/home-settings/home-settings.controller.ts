import {
  Body,
  Controller,
  Get,
  Inject,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';

import {
  type SafeguardingContactResponse,
  UpdateSafeguardingContactDto,
  UpdateSafeguardingContactSchema,
} from './dto.js';
import {
  type HomeSettingsContext,
  HomeSettingsService,
  type SafeguardingContactView,
} from './home-settings.service.js';

@ApiTags('home-settings')
@UseGuards(RolesGuard)
@Controller('settings/safeguarding-contact')
export class HomeSettingsController {
  constructor(@Inject(HomeSettingsService) private readonly settings: HomeSettingsService) {}

  @Get()
  @Roles('manager', 'safeguarding_lead', 'ops_admin')
  @ApiOkResponse({ description: 'Returns the configured safeguarding contact for this home.' })
  async get(@Req() request: FastifyRequest): Promise<SafeguardingContactResponse> {
    const contact = await this.settings.getSafeguardingContact(this.context(request));
    return this.response(contact, this.canUpdate(request));
  }

  @Put()
  @Roles('manager', 'ops_admin')
  @ApiOkResponse({ description: 'Updates or clears the safeguarding contact for this home.' })
  async update(
    @Body(new ZodValidationPipe(UpdateSafeguardingContactSchema))
    dto: UpdateSafeguardingContactDto,
    @Req() request: FastifyRequest,
  ): Promise<SafeguardingContactResponse> {
    const contact = await this.settings.updateSafeguardingContact(dto, this.context(request));
    return this.response(contact, true);
  }

  private canUpdate(request: FastifyRequest): boolean {
    return (
      request.tenant?.roles.includes('manager') === true ||
      request.tenant?.roles.includes('ops_admin') === true
    );
  }

  private context(request: FastifyRequest): HomeSettingsContext {
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

  private response(
    contact: SafeguardingContactView,
    canUpdate: boolean,
  ): SafeguardingContactResponse {
    return {
      canUpdate,
      configured: contact.email !== null && contact.name !== null,
      email: contact.email,
      name: contact.name,
      updatedAt: contact.updatedAt,
    };
  }
}
