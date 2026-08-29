import { type FastifyRequest } from 'fastify';

export interface AuthClaims {
  readonly email?: string;
  readonly homeIds: readonly string[];
  readonly roles: readonly string[];
  readonly sub: string;
  readonly tenantId: string;
}

export interface TenantContext {
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly homeId: string;
  readonly roles: readonly string[];
  readonly tenantId: string;
  readonly userSub: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthClaims;
    tenant?: TenantContext;
  }
}

export function firstHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
