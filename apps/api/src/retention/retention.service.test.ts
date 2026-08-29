import { describe, expect, it, vi } from 'vitest';

import { RetentionService } from './retention.service.js';

const context = {
  actorUserId: '33333333-3333-4333-8333-333333333333',
  correlationId: 'corr-retention-runs',
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('RetentionService.listRuns', () => {
  it('maps tenant-scoped run history', async () => {
    const startedAt = new Date('2026-07-15T02:00:00.000Z');
    const completedAt = new Date('2026-07-15T02:00:03.000Z');
    const queryRaw = vi.fn().mockResolvedValue([
      {
        action: 'object_delete',
        affectedCount: 2,
        completedAt,
        failureReason: null,
        id: '44444444-4444-4444-8444-444444444444',
        recordType: 'attachment',
        scannedCount: 2,
        startedAt,
        workflowId: 'retention-sweep-2026-07-15',
      },
    ]);
    const transaction = { $queryRaw: queryRaw };
    const withTenantContext = vi.fn(
      (_context: unknown, callback: (tx: typeof transaction) => unknown) =>
        Promise.resolve(callback(transaction)),
    );
    const service = new RetentionService({ withTenantContext } as unknown as ConstructorParameters<
      typeof RetentionService
    >[0]);

    await expect(service.listRuns(context)).resolves.toEqual({
      runs: [
        {
          action: 'object_delete',
          affectedCount: 2,
          completedAt: completedAt.toISOString(),
          failureReason: null,
          id: '44444444-4444-4444-8444-444444444444',
          recordType: 'attachment',
          scannedCount: 2,
          startedAt: startedAt.toISOString(),
          workflowId: 'retention-sweep-2026-07-15',
        },
      ],
    });
    expect(withTenantContext).toHaveBeenCalledWith(
      {
        actor: {
          correlationId: context.correlationId,
          kind: 'user',
          userId: context.actorUserId,
        },
        homeId: context.homeId,
        tenantId: context.tenantId,
      },
      expect.any(Function),
    );
  });
});
