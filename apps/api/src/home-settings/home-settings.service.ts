import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import type { UpdateSafeguardingContactDto } from './dto.js';

export interface HomeSettingsContext {
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly homeId: string;
  readonly tenantId: string;
}

export interface SafeguardingContactView {
  readonly email: string | null;
  readonly name: string | null;
  readonly updatedAt: string;
}

interface ContactRow {
  readonly email: string | null;
  readonly name: string | null;
  readonly updatedAt: Date;
}

@Injectable()
export class HomeSettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async getSafeguardingContact(ctx: HomeSettingsContext): Promise<SafeguardingContactView> {
    const rows = await this.prisma.withTenantContext(
      this.databaseContext(ctx),
      (transaction) =>
        transaction.$queryRaw<ContactRow[]>`
        SELECT
          safeguarding_contact_name AS "name",
          safeguarding_contact_email AS "email",
          updated_at AS "updatedAt"
        FROM core.homes
        WHERE id = ${ctx.homeId}::uuid
          AND tenant_id = ${ctx.tenantId}::uuid
        LIMIT 1
      `,
    );
    return this.requireRow(rows, ctx.homeId);
  }

  async updateSafeguardingContact(
    dto: UpdateSafeguardingContactDto,
    ctx: HomeSettingsContext,
  ): Promise<SafeguardingContactView> {
    const rows = await this.prisma.withTenantContext(
      this.databaseContext(ctx),
      (transaction) =>
        transaction.$queryRaw<ContactRow[]>`
        UPDATE core.homes
        SET
          safeguarding_contact_name = ${dto.name},
          safeguarding_contact_email = ${dto.email},
          updated_at = now()
        WHERE id = ${ctx.homeId}::uuid
          AND tenant_id = ${ctx.tenantId}::uuid
        RETURNING
          safeguarding_contact_name AS "name",
          safeguarding_contact_email AS "email",
          updated_at AS "updatedAt"
      `,
    );
    return this.requireRow(rows, ctx.homeId);
  }

  private requireRow(rows: readonly ContactRow[], homeId: string): SafeguardingContactView {
    const row = rows[0];
    if (row === undefined) throw new NotFoundException(`Home ${homeId} not found.`);
    return { email: row.email, name: row.name, updatedAt: row.updatedAt.toISOString() };
  }

  private databaseContext(ctx: HomeSettingsContext) {
    return {
      actor: { correlationId: ctx.correlationId, kind: 'user' as const, userId: ctx.actorUserId },
      homeId: ctx.homeId,
      tenantId: ctx.tenantId,
    };
  }
}
