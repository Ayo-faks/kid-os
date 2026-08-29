// Phase 3 §1 (D1 wiring) — postMattermostMessage worker activity.
//
// Resolves a (tenant, home, kind) channel mapping under tenant context and
// dispatches a message via the configured provider. Mapping lookup runs
// inside `withTenantContext` so RLS enforces tenant isolation and the audit
// trigger picks up the actor for any future mutations. Returns a result that
// always identifies whether the message was actually delivered so callers
// can branch on `disabled` vs `http` vs configuration errors.

import { createHash } from 'node:crypto';

import type { PostMattermostMessageInput, PostMattermostMessageResult } from '@careos/contracts';

import {
  buildMattermostProviderFromEnv,
  type MattermostProvider,
} from '../comms/mattermost-provider.js';
import { withTenantContext } from '../db/pg.js';

interface ChannelLookupRow {
  readonly channel_id: string;
}

let cachedProvider: MattermostProvider | undefined;

function resolveProvider(): MattermostProvider {
  if (cachedProvider === undefined) {
    cachedProvider = buildMattermostProviderFromEnv();
  }
  return cachedProvider;
}

// Test-only override; production code never calls this.
export function __setMattermostProviderForTests(provider: MattermostProvider | undefined): void {
  cachedProvider = provider;
}

export async function postMattermostMessage(
  input: PostMattermostMessageInput,
): Promise<PostMattermostMessageResult> {
  const provider = resolveProvider();

  const channelId = await withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      const result = await client.query<ChannelLookupRow>(
        `SELECT channel_id
           FROM core.channel_mappings
          WHERE tenant_id = $1::uuid
            AND home_id = $2::uuid
            AND kind = $3::"core"."ChannelKind"
          LIMIT 1`,
        [input.tenantId, input.homeId, input.channelKind],
      );
      return result.rows[0]?.channel_id ?? null;
    },
  );

  if (channelId === null) {
    return {
      channelId: null,
      delivered: false,
      providerKind: provider.kind,
      providerMessageId: null,
      reason: `channel-mapping-missing:${input.channelKind}`,
    };
  }

  const dispatch = await provider.postToChannel({
    channelId,
    correlationId: input.actor.correlationId,
    message: input.message,
    ...(input.deliveryId === undefined
      ? {}
      : {
          pendingPostId: createHash('sha256').update(input.deliveryId).digest('hex').slice(0, 26),
        }),
  });

  return {
    channelId,
    delivered: dispatch.delivered,
    providerKind: provider.kind,
    providerMessageId: dispatch.providerMessageId,
    reason: dispatch.reason,
  };
}
