import { createHash } from 'node:crypto';

import { ConflictException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';

import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import type { RedisService } from './redis.service.js';

const tenant = {
  actorUserId: '33333333-3333-4333-8333-333333333333',
  correlationId: 'corr-idempotency',
  homeId: '22222222-2222-4222-8222-222222222222',
  roles: ['support_worker'],
  tenantId: '11111111-1111-4111-8111-111111111111',
  userSub: 'keycloak-sub',
} as const;

function requestHash(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}

function harness(input?: {
  readonly cached?: string | null;
  readonly lockResult?: 'OK' | null;
  readonly storedRows?: readonly unknown[];
}) {
  const request = {
    body: { summary: 'same body' },
    headers: { 'idempotency-key': 'idem-1' },
    method: 'POST',
    tenant,
    url: '/incidents',
  } as unknown as FastifyRequest;
  const statusMock = vi.fn();
  const reply = {
    status: statusMock,
    statusCode: 202,
  } as unknown as FastifyReply;
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
  const handler = { handle: vi.fn(() => of({ id: 'incident-1' })) } satisfies CallHandler;

  const transaction = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    $queryRaw: vi.fn(() => Promise.resolve(input?.storedRows ?? [])),
  };
  const prisma = {
    withTenantContext: vi.fn(
      (_context: unknown, callback: (tx: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
  const lockResult =
    input !== undefined && Object.hasOwn(input, 'lockResult') ? input.lockResult : 'OK';
  const redisClient = {
    eval: vi.fn(() => Promise.resolve(1)),
    get: vi.fn(() => Promise.resolve(input?.cached ?? null)),
    set: vi.fn(() => Promise.resolve(lockResult)),
  };
  const redis = { client: redisClient };
  const interceptor = new IdempotencyInterceptor(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
  );

  return {
    context,
    handler,
    interceptor,
    prisma,
    redisClient,
    reply,
    request,
    statusMock,
    transaction,
  };
}

describe('IdempotencyInterceptor', () => {
  it.each(['/assistant/messages', '/incidents/draft-from-text'])(
    'does not require an idempotency key for advisory POST %s',
    async (url) => {
      const { context, handler, interceptor, request } = harness();
      Object.assign(request, { headers: {}, url });

      const observable = await interceptor.intercept(context, handler);
      await expect(firstValueFrom(observable)).resolves.toEqual({ id: 'incident-1' });
      expect(handler.handle).toHaveBeenCalledTimes(1);
    },
  );

  it('replays a matching cached response without executing the handler', async () => {
    const body = { summary: 'same body' };
    const cached = JSON.stringify({
      body: { id: 'existing' },
      method: 'POST',
      path: '/incidents',
      requestHash: requestHash(body),
      status: 202,
    });
    const { context, handler, interceptor, statusMock } = harness({ cached });

    const observable = await interceptor.intercept(context, handler);
    await expect(firstValueFrom(observable)).resolves.toEqual({ id: 'existing' });
    expect(statusMock).toHaveBeenCalledWith(202);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('rejects reuse when cached method/path/body identity differs', async () => {
    const cached = JSON.stringify({
      body: { id: 'existing' },
      method: 'POST',
      path: '/different-resource',
      requestHash: requestHash({ summary: 'same body' }),
      status: 202,
    });
    const { context, handler, interceptor } = harness({ cached });

    await expect(interceptor.intercept(context, handler)).rejects.toBeInstanceOf(ConflictException);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('rejects reuse when the durable Postgres identity differs on a Redis miss', async () => {
    const { context, handler, interceptor } = harness({
      storedRows: [
        {
          expires_at: new Date(Date.now() + 60_000),
          method: 'POST',
          path: '/incidents',
          request_hash: requestHash({ summary: 'different body' }),
          response_body: { id: 'existing' },
          response_status: 202,
        },
      ],
    });

    await expect(interceptor.intercept(context, handler)).rejects.toBeInstanceOf(ConflictException);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('rejects a concurrent duplicate while the first request owns the Redis claim', async () => {
    const { context, handler, interceptor } = harness({ lockResult: null });

    await expect(interceptor.intercept(context, handler)).rejects.toThrow(/already in progress/i);
    expect(handler.handle).not.toHaveBeenCalled();
  });
});
