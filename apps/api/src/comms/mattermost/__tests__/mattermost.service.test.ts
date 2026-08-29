import 'reflect-metadata';
/* eslint-disable @typescript-eslint/require-await -- Prisma mock methods return synchronous test fixtures. */
import {
  ForbiddenException,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service.js';
import { MattermostService } from '../mattermost.service.js';

interface LinkCodeRow {
  id: string;
  code: string;
  tenantId: string;
  homeId: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
  mattermostUserId: string | null;
  mattermostUsername: string | null;
}

interface UserRow {
  id: string;
  displayName: string;
}

interface LinkedIdentityRow {
  id: string;
  tenantId: string;
  userId: string;
  mattermostUserId: string;
  mattermostUsername: string;
  linkedAt: Date;
  revokedAt: Date | null;
}

class FakePrisma {
  readonly linkCodes = new Map<string, LinkCodeRow>();
  readonly users = new Map<string, UserRow>();
  readonly linkedIdentities: LinkedIdentityRow[] = [];

  linkCode = {
    create: vi.fn(
      async ({
        data,
      }: {
        data: Omit<LinkCodeRow, 'id' | 'usedAt' | 'mattermostUserId' | 'mattermostUsername'> &
          Partial<LinkCodeRow>;
      }) => {
        const row: LinkCodeRow = {
          id: `lc-${this.linkCodes.size + 1}`,
          code: data.code,
          tenantId: data.tenantId,
          homeId: data.homeId,
          userId: data.userId,
          expiresAt: data.expiresAt,
          usedAt: null,
          mattermostUserId: null,
          mattermostUsername: null,
        };
        this.linkCodes.set(row.code, row);
        return row;
      },
    ),
    findUnique: vi.fn(
      async ({ where }: { where: { code: string } }) => this.linkCodes.get(where.code) ?? null,
    ),
    update: vi.fn(
      async ({ data, where }: { data: Partial<LinkCodeRow>; where: { id: string } }) => {
        for (const row of this.linkCodes.values()) {
          if (row.id === where.id) {
            Object.assign(row, data);
            return row;
          }
        }
        throw new Error('not found');
      },
    ),
  };

  user = {
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) => this.users.get(where.id) ?? null,
    ),
  };

  linkedIdentity = {
    updateMany: vi.fn(
      async ({
        data,
        where,
      }: {
        data: Partial<LinkedIdentityRow>;
        where: { revokedAt: null; tenantId: string; userId: string };
      }) => {
        let count = 0;
        for (const row of this.linkedIdentities) {
          if (
            row.revokedAt === null &&
            row.tenantId === where.tenantId &&
            row.userId === where.userId
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    ),
    create: vi.fn(
      async ({ data }: { data: Omit<LinkedIdentityRow, 'id' | 'linkedAt' | 'revokedAt'> }) => {
        const row: LinkedIdentityRow = {
          id: `li-${this.linkedIdentities.length + 1}`,
          tenantId: data.tenantId,
          userId: data.userId,
          mattermostUserId: data.mattermostUserId,
          mattermostUsername: data.mattermostUsername,
          linkedAt: new Date(),
          revokedAt: null,
        };
        this.linkedIdentities.push(row);
        return row;
      },
    ),
  };

  async withTenantContext<T>(_context: unknown, fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const correlationId = 'corr-mm';

describe('MattermostService', () => {
  let prisma: FakePrisma;
  let service: MattermostService;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    prisma = new FakePrisma();
    prisma.users.set(userId, { id: userId, displayName: 'Test User' });
    service = new MattermostService(prisma as unknown as PrismaService);
    process.env.MATTERMOST_BOT_WEBHOOK_TOKEN = 'unit-test-token';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('issueLinkCode', () => {
    it('writes a 12-char hex code with a 10 minute expiry and returns the slash command', async () => {
      const before = Date.now();
      const result = await service.issueLinkCode(
        { mattermostHint: '@alice' },
        { correlationId, homeId, tenantId, userId },
      );
      const after = Date.now();

      expect(result.code).toMatch(/^[0-9A-F]{12}$/);
      expect(result.slashCommand).toBe(`/link ${result.code}`);
      const expiresAt = Date.parse(result.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 9 * 60 * 1000);
      expect(expiresAt).toBeLessThanOrEqual(after + 11 * 60 * 1000);

      expect(prisma.linkCode.create).toHaveBeenCalledTimes(1);
      const stored = [...prisma.linkCodes.values()][0]!;
      expect(stored.code).toBe(result.code);
      expect(stored.tenantId).toBe(tenantId);
      expect(stored.homeId).toBe(homeId);
      expect(stored.userId).toBe(userId);
    });

    it('generates a fresh code on every call', async () => {
      const a = await service.issueLinkCode({}, { correlationId, homeId, tenantId, userId });
      const b = await service.issueLinkCode({}, { correlationId, homeId, tenantId, userId });
      expect(a.code).not.toBe(b.code);
    });
  });

  describe('exchangeLinkCode', () => {
    const exchangePayload = {
      code: 'ABCDEF012345',
      tenantId,
      homeId,
      mattermostUserId: 'mm-user-1',
      mattermostUsername: 'alice',
    };

    function seedLinkCode(overrides: Partial<LinkCodeRow> = {}): LinkCodeRow {
      const row: LinkCodeRow = {
        id: 'lc-seed',
        code: exchangePayload.code,
        tenantId,
        homeId,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        mattermostUserId: null,
        mattermostUsername: null,
        ...overrides,
      };
      prisma.linkCodes.set(row.code, row);
      return row;
    }

    it('refuses when MATTERMOST_BOT_WEBHOOK_TOKEN is unset or change-me', async () => {
      process.env.MATTERMOST_BOT_WEBHOOK_TOKEN = '';
      await expect(service.exchangeLinkCode(exchangePayload, 'anything')).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      process.env.MATTERMOST_BOT_WEBHOOK_TOKEN = 'change-me';
      await expect(service.exchangeLinkCode(exchangePayload, 'change-me')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects a missing or mismatched bot token', async () => {
      await expect(service.exchangeLinkCode(exchangePayload, undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      await expect(service.exchangeLinkCode(exchangePayload, 'wrong-token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('throws NotFound for an unknown code', async () => {
      await expect(
        service.exchangeLinkCode(exchangePayload, 'unit-test-token'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequest if the code is already used', async () => {
      seedLinkCode({ usedAt: new Date() });
      await expect(
        service.exchangeLinkCode(exchangePayload, 'unit-test-token'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequest if the code has expired', async () => {
      seedLinkCode({ expiresAt: new Date(Date.now() - 1_000) });
      await expect(
        service.exchangeLinkCode(exchangePayload, 'unit-test-token'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks the code used, revokes any prior identity, and inserts a new one', async () => {
      seedLinkCode();
      prisma.linkedIdentities.push({
        id: 'li-prior',
        tenantId,
        userId,
        mattermostUserId: 'old-mm',
        mattermostUsername: 'old',
        linkedAt: new Date(Date.now() - 60_000),
        revokedAt: null,
      });

      const result = await service.exchangeLinkCode(exchangePayload, 'unit-test-token');
      expect(result).toEqual({ displayName: 'Test User', linked: true, userId });

      const stored = prisma.linkCodes.get(exchangePayload.code);
      expect(stored?.usedAt).toBeInstanceOf(Date);
      expect(stored?.mattermostUserId).toBe('mm-user-1');

      const prior = prisma.linkedIdentities.find((row) => row.mattermostUserId === 'old-mm');
      expect(prior?.revokedAt).toBeInstanceOf(Date);

      const fresh = prisma.linkedIdentities.find((row) => row.mattermostUserId === 'mm-user-1');
      expect(fresh).toBeDefined();
      expect(fresh?.revokedAt).toBeNull();
    });
  });
});
