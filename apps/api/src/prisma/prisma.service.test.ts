import type { Prisma } from '@prisma/client';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { PrismaService } from './prisma.service.js';

describe('PrismaService.withTenantContext', () => {
  it('requires callers to provide an explicit actor kind', () => {
    type Context = Parameters<PrismaService['withTenantContext']>[0];
    expectTypeOf<Context>().toMatchTypeOf<{
      actor: { kind: 'user' | 'agent' | 'system' };
      homeId: string;
      tenantId: string;
    }>();
  });

  it('sets all seven GUCs transaction-locally and invokes the callback on that transaction', async () => {
    const prisma = new PrismaService();
    const executeRaw = vi.fn(() => Promise.resolve(1));
    const transaction = { $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
    const transactionSpy = vi
      .spyOn(prisma, '$transaction')
      .mockImplementation(async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(transaction),
      );
    const callback = vi.fn(() => Promise.resolve('result'));

    const result = await prisma.withTenantContext(
      {
        actor: {
          agentRunId: 'agent-run',
          correlationId: 'corr-1',
          kind: 'agent',
          promptHash: 'prompt-hash',
          userId: '33333333-3333-4333-8333-333333333333',
        },
        homeId: '22222222-2222-4222-8222-222222222222',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
      callback,
    );

    expect(result).toBe('result');
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(transaction);
    expect(executeRaw).toHaveBeenCalledTimes(1);

    const [strings, ...values] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join('?');
    for (const name of [
      'tenant_id',
      'home_id',
      'actor_kind',
      'actor_user_id',
      'correlation_id',
      'agent_run_id',
      'prompt_hash',
    ]) {
      expect(sql).toContain(`app.current_${name}`);
    }
    expect(sql.match(/, true\)/g)).toHaveLength(7);
    expect(values).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'agent',
      '33333333-3333-4333-8333-333333333333',
      'corr-1',
      'agent-run',
      'prompt-hash',
    ]);
  });

  it('sets a system-only context with blank tenant and home scope', async () => {
    const prisma = new PrismaService();
    const executeRaw = vi.fn(() => Promise.resolve(1));
    const transaction = { $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
    vi.spyOn(prisma, '$transaction').mockImplementation(
      async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => callback(transaction),
    );
    const callback = vi.fn(() => Promise.resolve('system-result'));

    await expect(
      prisma.withSystemContext({ correlationId: 'system-ping' }, callback),
    ).resolves.toBe('system-result');
    expect(callback).toHaveBeenCalledWith(transaction);

    const [strings, ...values] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toContain("set_config('app.current_actor_kind', 'system', true)");
    expect(values).toEqual(['system-ping']);
  });
});
