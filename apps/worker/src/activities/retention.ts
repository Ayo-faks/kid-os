// Phase 4 §3 — Retention sweep activities.

import type {
  ApplyRetentionPolicyInput,
  ApplyRetentionPolicyResult,
  ListActiveRetentionPoliciesInput,
  ListActiveRetentionPoliciesResult,
  RetentionPolicySnapshot,
  RetentionAction,
  RetentionRecordType,
} from '@careos/contracts';

import { withSystemContext, withTenantContext } from '../db/pg.js';
import {
  attachmentsBucketName,
  createRetentionObjectStore,
  type RetentionObjectStore,
} from '../storage/retention-store.js';

let retentionObjectStoreOverride: RetentionObjectStore | undefined;
export function __setRetentionObjectStoreForTests(store: RetentionObjectStore | undefined): void {
  retentionObjectStoreOverride = store;
}

interface PolicyDbRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly record_type: RetentionRecordType;
  readonly retention_days: number;
  readonly action: RetentionAction;
  readonly enabled: boolean;
}

export async function listActiveRetentionPolicies(
  input: ListActiveRetentionPoliciesInput,
): Promise<ListActiveRetentionPoliciesResult> {
  return withSystemContext({ correlationId: input.correlationId ?? '' }, async (client) => {
    const rows = await client.query<PolicyDbRow>(
      `SELECT id::text AS id,
                tenant_id::text AS tenant_id,
                record_type,
                retention_days,
                action,
                enabled
           FROM core.retention_policies
          WHERE enabled = true
          ORDER BY tenant_id, record_type`,
      [],
    );
    const policies: RetentionPolicySnapshot[] = rows.rows.map((row) => ({
      action: row.action,
      enabled: row.enabled,
      id: row.id,
      recordType: row.record_type,
      retentionDays: row.retention_days,
      tenantId: row.tenant_id,
    }));
    return { policies };
  });
}

export async function applyRetentionPolicy(
  input: ApplyRetentionPolicyInput,
): Promise<ApplyRetentionPolicyResult> {
  const { policy, nowIso, actor, workflowId } = input;

  if (policy.action === 'object_delete' && policy.recordType !== 'attachment') {
    throw new Error('retention: object_delete is only valid for attachments');
  }

  // Enumerate homes for this tenant under a system-context read so the
  // sweep doesn't depend on a pre-existing home GUC.
  const homes = await withSystemContext({ correlationId: actor.correlationId }, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM core.homes WHERE tenant_id = $1::uuid ORDER BY id`,
      [policy.tenantId],
    );
    return result.rows;
  });

  let scannedTotal = 0;
  let affectedTotal = 0;

  for (const home of homes) {
    const homeResult = await applyToHome({
      actor,
      homeId: home.id,
      nowIso,
      policy,
    });
    scannedTotal += homeResult.scanned;
    affectedTotal += homeResult.affected;
  }

  // Record a single retention_runs row at tenant scope under a system actor.
  const run = await withTenantContext(
    {
      actor: { correlationId: actor.correlationId, kind: 'system', userId: null },
      homeId: homes[0]?.id ?? '',
      tenantId: policy.tenantId,
    },
    async (client) => {
      const inserted = await client.query<{
        affected_count: number;
        id: string;
        scanned_count: number;
      }>(
        `INSERT INTO core.retention_runs
           (tenant_id, policy_id, workflow_id, execution_key, record_type, action,
            scanned_count, affected_count, started_at, completed_at)
         VALUES ($1::uuid, $2::uuid, $3, $2::text || ':' || $3,
                 $4::"core"."RetentionRecordType",
                 $5::"core"."RetentionAction", $6, $7, NOW(), NOW())
         ON CONFLICT (execution_key) WHERE execution_key IS NOT NULL
         DO UPDATE SET workflow_id = EXCLUDED.workflow_id
         RETURNING id::text AS id, scanned_count, affected_count`,
        [
          policy.tenantId,
          policy.id,
          workflowId,
          policy.recordType,
          policy.action,
          scannedTotal,
          affectedTotal,
        ],
      );
      return inserted.rows[0];
    },
  );

  return {
    affectedCount: run?.affected_count ?? affectedTotal,
    runId: run?.id ?? '',
    scannedCount: run?.scanned_count ?? scannedTotal,
  };
}

async function applyToHome(args: {
  readonly policy: RetentionPolicySnapshot;
  readonly homeId: string;
  readonly nowIso: string;
  readonly actor: ApplyRetentionPolicyInput['actor'];
}): Promise<{ scanned: number; affected: number }> {
  const { policy, homeId, nowIso, actor } = args;
  if (policy.action === 'object_delete') {
    return applyAttachmentObjectDeletion(args);
  }

  return withTenantContext(
    {
      actor: { correlationId: actor.correlationId, kind: 'system', userId: null },
      homeId,
      tenantId: policy.tenantId,
    },
    async (client) => {
      const cutoffSql = `($1::timestamptz - ($2::int || ' days')::interval)`;
      const cutoffParams: readonly unknown[] = [nowIso, policy.retentionDays];

      const tableFor: Record<RetentionRecordType, string> = {
        attachment: 'core.attachments',
        email_draft: 'core.email_drafts',
        handover_record: 'core.handover_records',
        incident: 'core.incidents',
      };
      const targetCondition = `soft_deleted_at IS NULL`;
      const scan = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM ${tableFor[policy.recordType]}
          WHERE created_at < ${cutoffSql}
            AND ${targetCondition}`,
        [...cutoffParams],
      );
      const scanned = Number(scan.rows[0]?.count ?? '0');

      const setClause = `soft_deleted_at = $1::timestamptz,
          retention_policy_id = $3::uuid`;
      const isAttachment = policy.recordType === 'attachment';
      const setWithUpdatedAt = isAttachment
        ? setClause
        : `${setClause},
           updated_at = NOW()`;
      const upd = await client.query(
        `UPDATE ${tableFor[policy.recordType]}
            SET ${setWithUpdatedAt}
          WHERE created_at < ${cutoffSql}
            AND ${targetCondition}`,
        [...cutoffParams, policy.id],
      );
      return { affected: upd.rowCount ?? 0, scanned };
    },
  );
}

async function applyAttachmentObjectDeletion(args: {
  readonly policy: RetentionPolicySnapshot;
  readonly homeId: string;
  readonly nowIso: string;
  readonly actor: ApplyRetentionPolicyInput['actor'];
}): Promise<{ scanned: number; affected: number }> {
  const { policy, homeId, nowIso, actor } = args;
  const targets = await withTenantContext(
    {
      actor: { correlationId: actor.correlationId, kind: 'system', userId: null },
      homeId,
      tenantId: policy.tenantId,
    },
    async (client) => {
      const result = await client.query<{ readonly id: string; readonly object_key: string }>(
        `SELECT id::text AS id, object_key
           FROM core.attachments
          WHERE created_at < ($1::timestamptz - ($2::int || ' days')::interval)
            AND object_deleted_at IS NULL
          ORDER BY id`,
        [nowIso, policy.retentionDays],
      );
      return result.rows;
    },
  );

  const store = retentionObjectStoreOverride ?? createRetentionObjectStore();
  const bucket = attachmentsBucketName();
  let affected = 0;

  for (const target of targets) {
    await store.removeObject(bucket, target.object_key);
    if (await store.objectExists(bucket, target.object_key)) {
      throw new Error(`retention: object ${target.object_key} still exists after deletion`);
    }

    affected += await withTenantContext(
      {
        actor: { correlationId: actor.correlationId, kind: 'system', userId: null },
        homeId,
        tenantId: policy.tenantId,
      },
      async (client) => {
        const result = await client.query(
          `UPDATE core.attachments
              SET soft_deleted_at = COALESCE(soft_deleted_at, $1::timestamptz),
                  object_deleted_at = $1::timestamptz,
                  retention_policy_id = $2::uuid
            WHERE id = $3::uuid
              AND object_deleted_at IS NULL`,
          [nowIso, policy.id, target.id],
        );
        return result.rowCount ?? 0;
      },
    );
  }

  return { affected, scanned: targets.length };
}
