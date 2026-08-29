import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';

import type {
  ChannelMappingResponse,
  ExchangeLinkCodeDto,
  ExchangeLinkCodeResponse,
  IssueLinkCodeDto,
  IssueLinkCodeResponse,
  ListChannelMappingsResponse,
  UpsertChannelMappingDto,
} from './dto.js';

interface IssueContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly userId: string;
  readonly correlationId: string;
}

interface TenantContext {
  readonly tenantId: string;
  readonly homeId: string;
  readonly actorUserId?: string;
  readonly correlationId?: string;
}

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LINK_CODE_BYTES = 6; // 12-hex chars; easy to type in a Mattermost DM.

@Injectable()
export class MattermostService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async issueLinkCode(_dto: IssueLinkCodeDto, ctx: IssueContext): Promise<IssueLinkCodeResponse> {
    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);

    await this.prisma.withTenantContext(
      {
        actor: { correlationId: ctx.correlationId, kind: 'user', userId: ctx.userId },
        homeId: ctx.homeId,
        tenantId: ctx.tenantId,
      },
      (transaction) =>
        transaction.linkCode.create({
          data: {
            code,
            expiresAt,
            homeId: ctx.homeId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
          },
        }),
    );

    return {
      code,
      expiresAt: expiresAt.toISOString(),
      slashCommand: `/link ${code}`,
    };
  }

  async exchangeLinkCode(
    dto: ExchangeLinkCodeDto,
    botTokenHeader: string | undefined,
  ): Promise<ExchangeLinkCodeResponse> {
    this.verifyBotToken(botTokenHeader);

    const now = new Date();

    return this.prisma.withTenantContext(
      {
        actor: { kind: 'system' },
        homeId: dto.homeId,
        tenantId: dto.tenantId,
      },
      async (transaction) => {
        const linkCode = await transaction.linkCode.findUnique({ where: { code: dto.code } });
        if (linkCode === null) {
          throw new NotFoundException('Link code not found.');
        }
        if (linkCode.tenantId !== dto.tenantId || linkCode.homeId !== dto.homeId) {
          // RLS would already hide cross-tenant rows, but guard anyway.
          throw new NotFoundException('Link code not found.');
        }
        if (linkCode.usedAt !== null) {
          throw new BadRequestException('Link code already used.');
        }
        if (linkCode.expiresAt.getTime() <= now.getTime()) {
          throw new BadRequestException('Link code expired.');
        }

        await transaction.linkCode.update({
          data: {
            mattermostUserId: dto.mattermostUserId,
            mattermostUsername: dto.mattermostUsername,
            usedAt: now,
          },
          where: { id: linkCode.id },
        });

        const user = await transaction.user.findUnique({ where: { id: linkCode.userId } });
        if (user === null) {
          throw new NotFoundException('Linked user no longer exists.');
        }

        // Revoke any prior active identity for this CareOS user before binding.
        await transaction.linkedIdentity.updateMany({
          data: { revokedAt: now },
          where: {
            revokedAt: null,
            tenantId: dto.tenantId,
            userId: linkCode.userId,
          },
        });

        await transaction.linkedIdentity.create({
          data: {
            mattermostUserId: dto.mattermostUserId,
            mattermostUsername: dto.mattermostUsername,
            tenantId: dto.tenantId,
            userId: linkCode.userId,
          },
        });

        return {
          displayName: user.displayName,
          linked: true,
          userId: user.id,
        };
      },
    );
  }

  private generateCode(): string {
    return randomBytes(LINK_CODE_BYTES).toString('hex').toUpperCase();
  }

  private verifyBotToken(header: string | undefined): void {
    const expected = process.env.MATTERMOST_BOT_WEBHOOK_TOKEN ?? '';
    if (expected === '' || expected === 'change-me') {
      throw new ForbiddenException('Mattermost bot webhook is not configured.');
    }
    if (header === undefined || header === '') {
      throw new UnauthorizedException('Missing bot webhook token.');
    }
    const actualBuf = Buffer.from(header);
    const expectedBuf = Buffer.from(expected);
    if (actualBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException('Invalid bot webhook token.');
    }
    if (!timingSafeEqual(actualBuf, expectedBuf)) {
      throw new UnauthorizedException('Invalid bot webhook token.');
    }
  }

  async listChannelMappings(ctx: TenantContext): Promise<ListChannelMappingsResponse> {
    const rows = await this.prisma.withTenantContext(this.databaseContext(ctx), (transaction) =>
      transaction.channelMapping.findMany({
        orderBy: { kind: 'asc' },
        where: { homeId: ctx.homeId, tenantId: ctx.tenantId },
      }),
    );

    return {
      mappings: rows.map((row) => this.toMappingResponse(row)),
    };
  }

  async upsertChannelMapping(
    dto: UpsertChannelMappingDto,
    ctx: TenantContext,
  ): Promise<ChannelMappingResponse> {
    const row = await this.prisma.withTenantContext(this.databaseContext(ctx), (transaction) =>
      transaction.channelMapping.upsert({
        create: {
          channelId: dto.channelId,
          channelName: dto.channelName,
          homeId: ctx.homeId,
          kind: dto.kind,
          tenantId: ctx.tenantId,
        },
        update: { channelId: dto.channelId, channelName: dto.channelName },
        where: {
          tenantId_homeId_kind: {
            homeId: ctx.homeId,
            kind: dto.kind,
            tenantId: ctx.tenantId,
          },
        },
      }),
    );

    return this.toMappingResponse(row);
  }

  private databaseContext(ctx: TenantContext) {
    return {
      actor: {
        correlationId: ctx.correlationId,
        kind: 'user' as const,
        userId: ctx.actorUserId,
      },
      homeId: ctx.homeId,
      tenantId: ctx.tenantId,
    };
  }

  private toMappingResponse(row: {
    readonly id: string;
    readonly kind: 'home' | 'safeguarding' | 'rota' | 'general';
    readonly channelId: string;
    readonly channelName: string;
    readonly updatedAt: Date;
  }): ChannelMappingResponse {
    return {
      channelId: row.channelId,
      channelName: row.channelName,
      id: row.id,
      kind: row.kind,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
