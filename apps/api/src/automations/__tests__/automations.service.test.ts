import { describe, expect, it, vi } from 'vitest';

import { AutomationsService } from '../automations.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const actorUserId = '33333333-3333-4333-8333-333333333333';
const correlationId = 'corr-automations';

interface PrismaMock {
  readonly $queryRaw: ReturnType<typeof vi.fn>;
  readonly withTenantContext: ReturnType<typeof vi.fn>;
}

function createPrismaMock(rows: ReadonlyArray<Record<string, unknown>>): PrismaMock {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  const transaction = { $queryRaw: queryRaw };
  const withTenantContext = vi.fn((_context: unknown, fn: (t: typeof transaction) => unknown) =>
    Promise.resolve(fn(transaction)),
  );
  return { $queryRaw: queryRaw, withTenantContext };
}

describe('AutomationsService.listRecent', () => {
  it('returns mapped events and drops unknown actions', async () => {
    const occurredAt = new Date('2026-05-18T10:00:00.000Z');
    const prisma = createPrismaMock([
      {
        action: 'shift.reminder_dispatched',
        correlationId: 'corr-shift-1',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        metadata: { channelId: 'C1', delivered: true },
        occurredAt,
        subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        subjectType: 'shift',
      },
      {
        action: 'shift.handover_due_reminder_dispatched',
        correlationId: null,
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        metadata: null,
        occurredAt,
        subjectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        subjectType: 'shift',
      },
      {
        action: 'something.unrelated',
        correlationId: null,
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        metadata: null,
        occurredAt,
        subjectId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        subjectType: 'shift',
      },
    ]);

    const service = new AutomationsService(
      prisma as unknown as ConstructorParameters<typeof AutomationsService>[0],
    );

    const result = await service.listRecent({ actorUserId, correlationId, homeId, tenantId }, 20);

    expect(prisma.withTenantContext).toHaveBeenCalledWith(
      {
        actor: { correlationId, kind: 'user', userId: actorUserId },
        homeId,
        tenantId,
      },
      expect.any(Function),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toEqual({
      action: 'shift.reminder_dispatched',
      correlationId: 'corr-shift-1',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      metadata: { channelId: 'C1', delivered: true },
      occurredAt: occurredAt.toISOString(),
      subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      subjectType: 'shift',
    });
    expect(result.events[1]?.action).toBe('shift.handover_due_reminder_dispatched');
    expect(result.events[1]?.metadata).toBeNull();
  });

  it('returns an empty list when no automation events are recorded', async () => {
    const prisma = createPrismaMock([]);
    const service = new AutomationsService(
      prisma as unknown as ConstructorParameters<typeof AutomationsService>[0],
    );
    const result = await service.listRecent({ actorUserId, correlationId, homeId, tenantId }, 10);
    expect(result).toEqual({ events: [] });
  });
});
