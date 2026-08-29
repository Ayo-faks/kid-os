// Just-in-time provisioning of `core.users` rows from Keycloak JWT claims.
//
// Returns the local `core.users.id` for the request's authenticated subject,
// upserting on first encounter. The id is what `app.current_actor_user_id`
// needs so the Phase 1 §1 audit triggers can attribute writes correctly.

import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { type AuthClaims } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface ProvisionedUser {
  readonly id: string;
}

interface ProvisioningContext {
  readonly homeId: string;
  readonly correlationId: string;
}

@Injectable()
export class UsersService {
  private readonly cache = new Map<string, string>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolveOrProvision(
    claims: AuthClaims,
    context: ProvisioningContext,
  ): Promise<ProvisionedUser> {
    const cached = this.cache.get(claims.sub);

    if (cached !== undefined) {
      return { id: cached };
    }

    const email = claims.email ?? `${claims.sub}@careos.local`;
    const displayName = claims.email ?? claims.sub;
    const id = randomUUID();
    const rolesCsv = claims.roles.join(',');
    const homeIdsCsv = claims.homeIds.join(',');

    const rows = await this.prisma.withTenantContext(
      {
        actor: {
          correlationId: context.correlationId,
          kind: 'user',
          userId: null,
        },
        homeId: context.homeId,
        tenantId: claims.tenantId,
      },
      (transaction) => transaction.$queryRaw<Array<{ id: string }>>`
        INSERT INTO core.users (
          id,
          tenant_id,
          keycloak_sub,
          email,
          display_name,
          home_ids,
          roles,
          disabled,
          created_at,
          updated_at
        )
        VALUES (
          ${id}::uuid,
          ${claims.tenantId}::uuid,
          ${claims.sub},
          ${email},
          ${displayName},
          string_to_array(${homeIdsCsv}, ',')::uuid[],
          string_to_array(${rolesCsv}, ','),
          false,
          now(),
          now()
        )
        ON CONFLICT (keycloak_sub) DO UPDATE
        SET
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          home_ids = EXCLUDED.home_ids,
          roles = EXCLUDED.roles,
          updated_at = now()
        RETURNING id
      `,
    );

    const row = rows[0];

    if (row === undefined) {
      throw new Error('Failed to provision user row.');
    }

    this.cache.set(claims.sub, row.id);
    return { id: row.id };
  }
}
