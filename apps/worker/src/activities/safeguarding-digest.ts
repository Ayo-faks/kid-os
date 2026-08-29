// Phase 3 §3 (D3 slice 6) — weekly safeguarding digest activities.

import type {
  FindSafeguardingDigestTargetsInput,
  FindSafeguardingDigestTargetsResult,
  LoadSafeguardingDigestInput,
  RecordSafeguardingDigestAuditInput,
  RecordSafeguardingDigestAuditResult,
  SafeguardingDigest,
  SafeguardingDigestTarget,
} from '@careos/contracts';

import { withSystemContext, withTenantContext } from '../db/pg.js';

interface TargetRow {
  readonly tenant_id: string;
  readonly home_id: string;
}

interface CountRow {
  readonly count: string;
}

interface InsertedRow {
  readonly id: string;
}

export async function hasSafeguardingDigestAudit(input: {
  readonly actor: LoadSafeguardingDigestInput['actor'];
  readonly homeId: string;
  readonly nowIso: string;
  readonly tenantId: string;
}): Promise<boolean> {
  const dispatchKey = `${input.tenantId}:${input.homeId}:${input.nowIso}`;
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<InsertedRow>(
        `SELECT id
           FROM audit.events
          WHERE tenant_id = $1::uuid
            AND home_id = $2::uuid
            AND action = 'safeguarding.weekly_digest_dispatched'
            AND metadata ->> 'dispatch_key' = $3
          LIMIT 1`,
        [input.tenantId, input.homeId, dispatchKey],
      );
      return result.rows[0] !== undefined;
    },
  );
}

export async function findSafeguardingDigestTargets(
  input: FindSafeguardingDigestTargetsInput,
): Promise<FindSafeguardingDigestTargetsResult> {
  const rows = await withSystemContext({ correlationId: input.correlationId }, async (client) => {
    const result = await client.query<TargetRow>(
      `SELECT cm.tenant_id, cm.home_id
           FROM core.channel_mappings cm
          WHERE cm.kind = 'safeguarding'
          ORDER BY cm.tenant_id, cm.home_id`,
    );
    return result.rows;
  });

  const targets: SafeguardingDigestTarget[] = rows.map((row) => ({
    homeId: row.home_id,
    tenantId: row.tenant_id,
  }));
  return { targets };
}

export async function loadSafeguardingDigest(
  input: LoadSafeguardingDigestInput,
): Promise<SafeguardingDigest> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const sensitive = await client.query<CountRow>(
        `SELECT COUNT(*)::text AS count
           FROM core.email_drafts ed
          WHERE ed.created_at >= $1
            AND ed.created_at <  $2
            AND ed.sensitivity = 'sensitive'`,
        [input.sinceIso, input.nowIso],
      );
      const awaiting = await client.query<CountRow>(
        `SELECT COUNT(*)::text AS count
           FROM core.incidents i
          WHERE i.status IN ('awaiting_fields', 'awaiting_approval')`,
      );
      const opened = await client.query<CountRow>(
        `SELECT COUNT(*)::text AS count
           FROM core.incidents i
          WHERE i.created_at >= $1
            AND i.created_at <  $2`,
        [input.sinceIso, input.nowIso],
      );

      return {
        incidentsAwaitingAction: Number(awaiting.rows[0]?.count ?? '0'),
        incidentsOpened: Number(opened.rows[0]?.count ?? '0'),
        nowIso: input.nowIso,
        sensitiveEmailDrafts: Number(sensitive.rows[0]?.count ?? '0'),
        sinceIso: input.sinceIso,
      };
    },
  );
}

export async function recordSafeguardingDigestAudit(
  input: RecordSafeguardingDigestAuditInput,
): Promise<RecordSafeguardingDigestAuditResult> {
  const dispatchKey = `${input.tenantId}:${input.homeId}:${input.digest.nowIso}`;
  const inserted = await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<InsertedRow>(
        `INSERT INTO audit.events
           (tenant_id, home_id, actor_kind, correlation_id,
            action, subject_type, subject_id, metadata)
         VALUES ($1, $2, 'system', $3,
                 'safeguarding.weekly_digest_dispatched', 'home', $2, $4::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          input.tenantId,
          input.homeId,
          input.actor.correlationId,
          JSON.stringify({
            incidents_awaiting_action: input.digest.incidentsAwaitingAction,
            incidents_opened: input.digest.incidentsOpened,
            dispatch_key: dispatchKey,
            now: input.digest.nowIso,
            sensitive_email_drafts: input.digest.sensitiveEmailDrafts,
            since: input.digest.sinceIso,
          }),
        ],
      );
      if (result.rows[0] !== undefined) return result.rows[0];
      const existing = await client.query<InsertedRow>(
        `SELECT id
           FROM audit.events
          WHERE tenant_id = $1::uuid
            AND home_id = $2::uuid
            AND action = 'safeguarding.weekly_digest_dispatched'
            AND metadata ->> 'dispatch_key' = $3
          LIMIT 1`,
        [input.tenantId, input.homeId, dispatchKey],
      );
      return existing.rows[0] ?? null;
    },
  );

  return {
    auditEventId: inserted?.id ?? null,
    recorded: inserted !== null,
  };
}
