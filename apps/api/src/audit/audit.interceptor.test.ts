import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service.js';

import { AuditInterceptor } from './audit.interceptor.js';

const tenant = {
  actorUserId: '33333333-3333-4333-8333-333333333333',
  correlationId: 'corr-audit',
  homeId: '22222222-2222-4222-8222-222222222222',
  roles: ['support_worker'],
  tenantId: '11111111-1111-4111-8111-111111111111',
  userSub: 'non-uuid-keycloak-sub',
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('AuditInterceptor', () => {
  it('awaits the contextual insert and attributes it to the provisioned local user', async () => {
    const write = deferred<number>();
    const executeRaw = vi.fn(() => write.promise);
    const transaction = { $executeRaw: executeRaw };
    const prisma = {
      withTenantContext: vi.fn(
        (_context: unknown, callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };
    const interceptor = new AuditInterceptor(prisma as unknown as PrismaService);
    const request = {
      method: 'POST',
      tenant,
      url: '/incidents',
    } as unknown as FastifyRequest;
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const handler = { handle: vi.fn(() => of({ accepted: true })) } satisfies CallHandler;

    let settled = false;
    const resultPromise = firstValueFrom(interceptor.intercept(context, handler)).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(prisma.withTenantContext).toHaveBeenCalledWith(
      {
        actor: { correlationId: tenant.correlationId, kind: 'user', userId: tenant.actorUserId },
        homeId: tenant.homeId,
        tenantId: tenant.tenantId,
      },
      expect.any(Function),
    );

    write.resolve(1);
    await expect(resultPromise).resolves.toEqual({ accepted: true });

    const [, ...values] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(values).toContain(tenant.actorUserId);
    expect(values).not.toContain(tenant.userSub);
  });
});
