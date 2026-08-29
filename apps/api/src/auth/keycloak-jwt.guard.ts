import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { IS_PUBLIC_ROUTE } from '../common/public.decorator.js';
import { firstHeader, type AuthClaims } from '../common/request-context.js';

@Injectable()
export class KeycloakJwtGuard implements CanActivate {
  private readonly audience = process.env.API_JWT_AUDIENCE ?? 'api';
  private readonly issuer =
    process.env.KEYCLOAK_ISSUER ?? 'http://keycloak:8080/keycloak/realms/careos';
  private readonly jwksIssuer = process.env.KEYCLOAK_INTERNAL_ISSUER ?? this.issuer;
  private readonly jwks = createRemoteJWKSet(
    new URL(`${this.jwksIssuer}/protocol/openid-connect/certs`),
  );

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (process.env.CAREOS_TEST_AUTH_BYPASS === 'true') {
      request.auth = this.toTestAuthClaims(request);
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      return true;
    }

    const token = this.extractBearerToken(request);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        audience: this.audience,
        issuer: this.issuer,
      }));
    } catch {
      throw new UnauthorizedException('Invalid or expired bearer token.');
    }

    request.auth = this.toAuthClaims(payload);

    return true;
  }

  private extractBearerToken(request: FastifyRequest): string {
    const authorization = firstHeader(request, 'authorization');

    if (authorization === undefined) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    const [scheme, token] = authorization.split(' ');

    if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token.length === 0) {
      throw new UnauthorizedException('Invalid bearer token.');
    }

    return token;
  }

  private toAuthClaims(payload: JWTPayload): AuthClaims {
    const tenantId = this.stringClaim(payload.tenant_id);
    const sub = this.stringClaim(payload.sub);

    if (tenantId === undefined || sub === undefined) {
      throw new UnauthorizedException('Token is missing required tenant claims.');
    }

    return {
      email: this.stringClaim(payload.email),
      homeIds: this.stringArrayClaim(payload.home_ids),
      roles: this.rolesClaim(payload),
      sub,
      tenantId,
    };
  }

  private rolesClaim(payload: JWTPayload): readonly string[] {
    const roles = this.stringArrayClaim(payload.roles);
    const realmAccess = payload.realm_access;

    if (
      roles.length > 0 ||
      typeof realmAccess !== 'object' ||
      realmAccess === null ||
      !('roles' in realmAccess)
    ) {
      return roles;
    }

    return this.stringArrayClaim(realmAccess.roles);
  }

  private stringArrayClaim(value: unknown): readonly string[] {
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.splitCsvClaim(item));
    }

    return this.splitCsvClaim(value);
  }

  private splitCsvClaim(value: unknown): readonly string[] {
    if (typeof value !== 'string') {
      return [];
    }

    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  private stringClaim(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private toTestAuthClaims(request: FastifyRequest): AuthClaims {
    const tenantId = firstHeader(request, 'x-test-tenant-id');
    const sub = firstHeader(request, 'x-test-sub') ?? 'test-user';

    if (tenantId === undefined) {
      throw new UnauthorizedException('Test auth bypass requires x-test-tenant-id.');
    }

    return {
      email: firstHeader(request, 'x-test-email'),
      homeIds: this.stringArrayClaim(firstHeader(request, 'x-test-home-ids')),
      roles: this.stringArrayClaim(firstHeader(request, 'x-test-roles')),
      sub,
      tenantId,
    };
  }
}
