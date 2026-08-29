import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type FastifyRequest } from 'fastify';

import { getCorrelationId } from '../common/correlation.js';
import { IS_PUBLIC_ROUTE } from '../common/public.decorator.js';
import { firstHeader } from '../common/request-context.js';
import { UsersService } from '../users/users.service.js';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(UsersService)
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (request.auth === undefined) {
      throw new UnauthorizedException('Authentication context is missing.');
    }

    const homeId = firstHeader(request, 'x-careos-home-id') ?? request.auth.homeIds[0];

    if (homeId === undefined || !request.auth.homeIds.includes(homeId)) {
      throw new ForbiddenException('Requested home is outside token scope.');
    }

    const correlationId = getCorrelationId(request);

    const provisioned = await this.users.resolveOrProvision(request.auth, {
      correlationId,
      homeId,
    });

    request.tenant = {
      actorUserId: provisioned.id,
      correlationId,
      homeId,
      roles: request.auth.roles,
      tenantId: request.auth.tenantId,
      userSub: request.auth.sub,
    };

    return true;
  }
}
