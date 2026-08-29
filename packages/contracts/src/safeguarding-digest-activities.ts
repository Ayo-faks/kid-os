// Phase 3 §3 (D3 slice 6) — weekly safeguarding digest activity contracts.
// Schedule sweeps homes with a `safeguarding` channel mapping and posts a
// rolled-up Mattermost message summarising the past 7 days of sensitive
// drafts and incidents needing review.

export interface SafeguardingDigestActor {
  readonly correlationId: string;
  readonly kind: 'system';
  readonly userId: null;
}

export interface FindSafeguardingDigestTargetsInput {
  readonly correlationId: string;
}

export interface SafeguardingDigestTarget {
  readonly tenantId: string;
  readonly homeId: string;
}

export interface FindSafeguardingDigestTargetsResult {
  readonly targets: readonly SafeguardingDigestTarget[];
}

export interface LoadSafeguardingDigestInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly sinceIso: string;
  readonly nowIso: string;
  readonly actor: SafeguardingDigestActor;
}

export interface SafeguardingDigest {
  readonly sinceIso: string;
  readonly nowIso: string;
  readonly sensitiveEmailDrafts: number;
  readonly incidentsAwaitingAction: number;
  readonly incidentsOpened: number;
}

export interface RecordSafeguardingDigestAuditInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly actor: SafeguardingDigestActor;
  readonly digest: SafeguardingDigest;
}

export interface RecordSafeguardingDigestAuditResult {
  readonly recorded: boolean;
  readonly auditEventId: string | null;
}
