import { createHash } from 'node:crypto';

import {
  incidentFollowUpWorkflowId,
  resolvePostApprovalActions,
  type EnsureFollowUpExportBundleInput,
  type EnsureIncidentFollowUpActionsInput,
  type IncidentFollowUpActionDescriptor,
  type LoadSafeguardingContactInput,
  type LoadSafeguardingContactResult,
  type PostApprovalActionKind,
  type TransitionIncidentFollowUpInput,
} from '@careos/contracts';

import { withTenantContext } from '../db/pg.js';

interface ActionRow {
  readonly action_id: string;
  readonly attempt: number;
  readonly kind: PostApprovalActionKind;
  readonly target_id: string;
  readonly workflow_id: string;
}

interface WorkflowOwnerRow {
  readonly instance_id: string;
  readonly runtime: 'durable' | 'temporal';
}

export async function ensureIncidentFollowUpActions(
  input: EnsureIncidentFollowUpActionsInput,
): Promise<readonly IncidentFollowUpActionDescriptor[]> {
  const kinds = resolvePostApprovalActions('incident', {
    immediateRisk: input.immediateRisk,
    safeguarding: input.safeguarding,
  });
  if (kinds.length === 0) return [];

  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      for (const kind of kinds) {
        const actionId = stableUuid(`incident-follow-up:${input.incidentId}:${kind}`);
        const targetId = stableUuid(`incident-follow-up:${actionId}:target`);
        const workflowId = incidentFollowUpWorkflowId(actionId, 1);
        await client.query(
          `INSERT INTO core.incident_follow_up_actions
             (id, tenant_id, home_id, incident_id, kind, status, target_id, workflow_id,
              attempt, requested_by_user_id, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
             $5::"core"."IncidentFollowUpKind", 'queued', $6::uuid, $7, 1, $8::uuid, now(), now())
           ON CONFLICT (tenant_id, home_id, incident_id, kind) DO NOTHING`,
          [
            actionId,
            input.tenantId,
            input.homeId,
            input.incidentId,
            kind,
            targetId,
            workflowId,
            input.actor.userId,
          ],
        );
      }

      const rows = await client.query<ActionRow>(
        `SELECT id::text AS action_id, kind::text AS kind, attempt,
          target_id::text AS target_id, workflow_id
           FROM core.incident_follow_up_actions
          WHERE incident_id = $1::uuid
            AND kind = ANY($2::"core"."IncidentFollowUpKind"[])
          ORDER BY kind ASC`,
        [input.incidentId, kinds],
      );
      const actions = rows.rows.map((row) => ({
        actionId: row.action_id,
        attempt: row.attempt,
        kind: row.kind,
        targetId: row.target_id,
        workflowId: row.workflow_id,
      }));
      if (input.runtime !== undefined) {
        for (const action of actions) {
          await client.query(
            `INSERT INTO core.workflow_instances (
               id, tenant_id, home_id, workflow_kind, subject_type, subject_id,
               runtime, instance_id, orchestration_name, orchestration_version,
               status, correlation_id, created_at, updated_at
             ) VALUES (
               gen_random_uuid(), $1::uuid, $2::uuid, 'incident-follow-up',
               'incident_follow_up_action', $3::uuid,
               $4::"core"."WorkflowRuntimeKind", $5, $6, $7,
               'running', $8, now(), now()
             )
             ON CONFLICT (tenant_id, home_id, workflow_kind, subject_type, subject_id)
             DO NOTHING`,
            [
              input.tenantId,
              input.homeId,
              action.actionId,
              input.runtime,
              action.workflowId,
              input.orchestrationName ?? 'IncidentFollowUpActionWorkflow',
              input.orchestrationVersion ?? null,
              input.actor.correlationId,
            ],
          );
          const owner = await client.query<WorkflowOwnerRow>(
            `SELECT instance_id, runtime::text AS runtime
               FROM core.workflow_instances
              WHERE tenant_id = $1::uuid
                AND home_id = $2::uuid
                AND workflow_kind = 'incident-follow-up'
                AND subject_type = 'incident_follow_up_action'
                AND subject_id = $3::uuid
              LIMIT 1`,
            [input.tenantId, input.homeId, action.actionId],
          );
          const row = owner.rows[0];
          if (
            row === undefined ||
            row.runtime !== input.runtime ||
            row.instance_id !== action.workflowId
          ) {
            throw new Error(
              `Incident follow-up ${action.actionId} has conflicting workflow ownership.`,
            );
          }
        }
      }
      return actions;
    },
  );
}

export async function loadSafeguardingContact(
  input: LoadSafeguardingContactInput,
): Promise<LoadSafeguardingContactResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<{
        readonly email: string | null;
        readonly name: string | null;
      }>(
        `SELECT safeguarding_contact_name AS name, safeguarding_contact_email AS email
           FROM core.homes WHERE id = $1::uuid LIMIT 1`,
        [input.homeId],
      );
      const contact = result.rows[0];
      if (contact?.email === null || contact?.email === undefined || contact.name === null) {
        return { configured: false };
      }
      return { configured: true, email: contact.email, name: contact.name };
    },
  );
}

export async function transitionIncidentFollowUp(
  input: TransitionIncidentFollowUpInput,
): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.incident_follow_up_actions
            SET status = $2::"core"."IncidentFollowUpStatus",
                target_id = COALESCE($3::uuid, target_id),
                failure_code = $4,
                failure_reason = $5,
                updated_at = now()
          WHERE id = $1::uuid`,
        [
          input.actionId,
          input.status,
          input.targetId ?? null,
          input.failureCode ?? null,
          input.failureReason?.slice(0, 500) ?? null,
        ],
      );
    },
  );
}

export async function ensureFollowUpExportBundle(
  input: EnsureFollowUpExportBundleInput,
): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `INSERT INTO core.export_bundles
           (id, tenant_id, home_id, incident_id, requested_by_user_id,
            workflow_id, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
           'pending'::"core"."ExportBundleStatus", now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [
          input.bundleId,
          input.tenantId,
          input.homeId,
          input.incidentId,
          input.requestedByUserId,
          input.workflowId,
        ],
      );
    },
  );
}

function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('Unable to derive incident follow-up id.');
  }
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
