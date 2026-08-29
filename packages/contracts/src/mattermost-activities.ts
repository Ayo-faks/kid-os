// Phase 3 §1 (D1 wiring) — Mattermost message dispatch contract.
//
// The worker activity `postMattermostMessage` resolves a `(tenant, home, kind)`
// channel mapping under tenant context and dispatches to the configured
// provider. The "disabled" provider records intent without a network call.

import type { IncidentActor } from './incidents-workflow.js';

export type MattermostChannelKind = 'home' | 'safeguarding' | 'rota' | 'general';

export interface PostMattermostMessageInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly channelKind: MattermostChannelKind;
  readonly message: string;
  readonly actor: IncidentActor;
  readonly deliveryId?: string;
}

export interface PostMattermostMessageResult {
  readonly delivered: boolean;
  readonly providerKind: 'disabled' | 'http';
  readonly providerMessageId: string | null;
  readonly channelId: string | null;
  readonly reason?: string;
}
