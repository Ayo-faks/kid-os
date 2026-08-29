import { describe, expect, it, vi } from 'vitest';

import { UpdateSafeguardingContactSchema } from './dto.js';
import { HomeSettingsService } from './home-settings.service.js';

const context = {
  actorUserId: '33333333-3333-4333-8333-333333333333',
  correlationId: 'corr-home-settings',
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('HomeSettingsService', () => {
  it('reads and updates the contact inside the active home database context', async () => {
    const updatedAt = new Date('2026-07-17T09:00:00.000Z');
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ email: null, name: null, updatedAt }])
      .mockResolvedValueOnce([
        { email: 'dsl@willow.example', name: 'Willow safeguarding lead', updatedAt },
      ]);
    const transaction = { $queryRaw: queryRaw };
    const withTenantContext = vi.fn(
      (_context: unknown, callback: (tx: typeof transaction) => unknown) =>
        Promise.resolve(callback(transaction)),
    );
    const service = new HomeSettingsService({
      withTenantContext,
    } as unknown as ConstructorParameters<typeof HomeSettingsService>[0]);

    await expect(service.getSafeguardingContact(context)).resolves.toEqual({
      email: null,
      name: null,
      updatedAt: updatedAt.toISOString(),
    });
    await expect(
      service.updateSafeguardingContact(
        { email: 'dsl@willow.example', name: 'Willow safeguarding lead' },
        context,
      ),
    ).resolves.toEqual({
      email: 'dsl@willow.example',
      name: 'Willow safeguarding lead',
      updatedAt: updatedAt.toISOString(),
    });
    expect(withTenantContext).toHaveBeenCalledTimes(2);
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

  it('requires a valid name and email pair or an explicit clear', () => {
    expect(
      UpdateSafeguardingContactSchema.safeParse({
        email: 'dsl@willow.example',
        name: 'Willow safeguarding lead',
      }).success,
    ).toBe(true);
    expect(UpdateSafeguardingContactSchema.safeParse({ email: null, name: null }).success).toBe(
      true,
    );
    expect(
      UpdateSafeguardingContactSchema.safeParse({ email: 'not-an-email', name: 'Lead' }).success,
    ).toBe(false);
    expect(
      UpdateSafeguardingContactSchema.safeParse({ email: 'dsl@willow.example', name: null })
        .success,
    ).toBe(false);
  });
});
