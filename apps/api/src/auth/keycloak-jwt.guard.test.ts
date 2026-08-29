import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KeycloakJwtGuard } from './keycloak-jwt.guard.js';

function makeContext(authorization: string | undefined): ExecutionContext {
  const request = { headers: authorization === undefined ? {} : { authorization } };
  return {
    getClass: () => ({}),
    getHandler: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const reflector = {
  getAllAndOverride: () => false,
} as unknown as Reflector;

describe('KeycloakJwtGuard', () => {
  let jwks: Server;
  let issuer: string;
  let signKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    signKey = privateKey;
    const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'test-key' };
    jwks = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
    process.env.KEYCLOAK_ISSUER = issuer;
    process.env.KEYCLOAK_INTERNAL_ISSUER = issuer;
  });

  afterAll(async () => {
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_INTERNAL_ISSUER;
    await new Promise<void>((resolve) => {
      jwks.close(() => resolve());
    });
  });

  it('maps an expired token to 401, not an unhandled 500', async () => {
    const guard = new KeycloakJwtGuard(reflector);
    const expired = await new SignJWT({ tenant_id: 't-1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject('user-1')
      .setAudience('api')
      .setIssuer(issuer)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(signKey);

    await expect(guard.canActivate(makeContext(`Bearer ${expired}`))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a missing bearer token with 401', async () => {
    const guard = new KeycloakJwtGuard(reflector);
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
