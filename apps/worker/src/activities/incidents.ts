// Activities for the IncidentReportWorkflow (Phase 1 §5).
//
// These run in the worker process — they're allowed Node IO, DB access,
// outbound HTTP. The workflow code that calls them is deterministic and
// sandboxed; everything side-effecty lives here.

import { createHash, randomUUID } from 'node:crypto';

import type {
  DraftFromTextInput,
  DraftFromTextResult,
  ExportPdfInput,
  ExportPdfResult,
  PersistIncidentVersionInput,
  PersistIncidentVersionResult,
  RouteForApprovalInput,
  ResolveIncidentApprovalRequirementInput,
  ResolveIncidentApprovalRequirementResult,
  ValidateAgainstSchemaInput,
  ValidateAgainstSchemaResult,
  WriteAuditEventInput,
} from '@careos/contracts';
import { resolveApprovalRequirement } from '@careos/contracts';
import { validateFormData } from '@careos/schemas';

import { withTenantContext } from '../db/pg.js';

import {
  createGotenbergConverter,
  createMinioStore,
  exportBucketName,
  objectKeyFor,
  renderIncidentHtml,
  sha256Hex,
} from './export-pdf.js';
import { callHermesTool } from './hermes.js';

// 1 ──────────────────────────────────────────────────────────────────────────
// draftIncidentFromText: ask Hermes to extract structured form data. Hermes is
// responsible for MCP schema reads and llm-gateway egress. We NEVER auto-submit — the workflow
// only persists this as a draft version and surfaces missingMandatory back to
// the UI.
export async function draftIncidentFromText(
  input: DraftFromTextInput,
): Promise<DraftFromTextResult> {
  const promptHash = sha256(
    JSON.stringify({
      narrative: input.narrative,
      template: input.formTemplate,
    }),
  );

  const json = await callHermesTool<{
    readonly confidence: number;
    readonly form_data: Record<string, unknown>;
    readonly missing_mandatory: readonly string[];
  }>(
    'draft_incident_from_text',
    {
      correlation_id: input.correlationId,
      free_text: input.narrative,
      resident_id: input.residentId,
      template_id: input.formTemplate.templateId,
    },
    {
      correlationId: input.correlationId,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
  );

  return {
    confidence: json.confidence,
    formData: json.form_data,
    missingMandatory: json.missing_mandatory,
    promptHash,
  };
}

// 2 ──────────────────────────────────────────────────────────────────────────
// validateAgainstSchema: pure, deterministic check against the JSON Schema
// shipped in @careos/schemas. Used to decide AwaitingFields vs AwaitingApproval.
// eslint-disable-next-line @typescript-eslint/require-await -- activity contract requires Promise return
export async function validateAgainstSchema(
  input: ValidateAgainstSchemaInput,
): Promise<ValidateAgainstSchemaResult> {
  return validateFormData(
    input.formTemplate.templateId,
    input.formTemplate.version,
    input.formData,
  );
}

// Deterministic safeguarding routing. Only trusted template identity and
// explicit staff-entered fields can raise the approval level; model advisory
// fields (for example `aiSafeguardingSuggestion`) are intentionally ignored.
// eslint-disable-next-line @typescript-eslint/require-await -- Temporal activity contract is Promise-based
export async function resolveIncidentApprovalRequirement(
  input: ResolveIncidentApprovalRequirementInput,
): Promise<ResolveIncidentApprovalRequirementResult> {
  const immediateRisk = input.formData.isChildAtImmediateRisk === true;
  const safeguarding =
    input.formTemplate.templateId === 'incident.safeguarding' ||
    input.formData.safeguardingConcern === true ||
    immediateRisk ||
    input.formData.reportedToDsl === true ||
    isSafeguardingCategory(input.formData.category);
  const requirement = resolveApprovalRequirement('draft_incident_from_text', { safeguarding });
  if (requirement.signaturesRequired !== 1 && requirement.signaturesRequired !== 2) {
    throw new Error('Incident approval policy must require at least one signature.');
  }
  return {
    immediateRisk,
    level: requirement.level,
    requiredRoles: requirement.requiredRoles,
    safeguarding,
    signaturesRequired: requirement.signaturesRequired,
  };
}

function isSafeguardingCategory(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    [
      'physical_abuse',
      'sexual_abuse',
      'emotional_abuse',
      'neglect',
      'exploitation',
      'online_harm',
      'self_neglect',
    ].includes(value)
  );
}

// 3 ──────────────────────────────────────────────────────────────────────────
// persistIncidentVersion: INSERT incident row on version=1, append a new
// incident_versions row, and write a timeline_entries row. All inside one
// transaction with RLS GUCs set so the audit triggers can attribute the write.
export async function persistIncidentVersion(
  input: PersistIncidentVersionInput,
): Promise<PersistIncidentVersionResult> {
  return withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      const templateRow = await client.query<{ id: string }>(
        `SELECT id FROM core.form_templates
          WHERE tenant_id = $1::uuid AND template_id = $2 AND version = $3
          LIMIT 1`,
        [input.tenantId, input.formTemplate.templateId, input.formTemplate.version],
      );
      const formTemplateId = templateRow.rows[0]?.id;
      if (!formTemplateId) {
        throw new Error(
          `persistIncidentVersion: form template ${input.formTemplate.templateId}@${input.formTemplate.version} is not registered for tenant ${input.tenantId}.`,
        );
      }

      if (input.version === 1) {
        await client.query(
          `INSERT INTO core.incidents
             (id, tenant_id, home_id, resident_id, form_template_id, workflow_id,
              status, current_version, author_user_id, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6,
                   $7::"core"."IncidentStatus", $8, $9::uuid, now(), now())
           ON CONFLICT (id) DO NOTHING`,
          [
            input.incidentId,
            input.tenantId,
            input.homeId,
            input.residentId,
            formTemplateId,
            input.workflowId,
            input.status,
            input.version,
            input.authorUserId,
          ],
        );
      } else {
        await client.query(
          `UPDATE core.incidents
              SET status = $2::"core"."IncidentStatus",
                  current_version = $3,
                  approved_by_user_id = CASE
                    WHEN $2::"core"."IncidentStatus" = 'approved' THEN $4::uuid
                    WHEN $2::"core"."IncidentStatus" = 'rejected' THEN NULL
                    ELSE approved_by_user_id
                  END,
                  approved_at = CASE
                    WHEN $2::"core"."IncidentStatus" = 'approved' THEN COALESCE(approved_at, now())
                    WHEN $2::"core"."IncidentStatus" = 'rejected' THEN NULL
                    ELSE approved_at
                  END,
                  updated_at = now()
            WHERE id = $1::uuid`,
          [input.incidentId, input.status, input.version, input.actor.userId],
        );
      }

      const versionId = randomUUID();
      await client.query(
        `INSERT INTO core.incident_versions
           (id, tenant_id, home_id, incident_id, version, status, form_data,
            missing_mandatory, validation_errors, actor_kind, actor_user_id,
            agent_run_id, prompt_hash, correlation_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::"core"."IncidentStatus",
                 $7::jsonb, $8::text[], $9::jsonb, $10, $11::uuid, $12, $13, $14, now())`,
        [
          versionId,
          input.tenantId,
          input.homeId,
          input.incidentId,
          input.version,
          input.status,
          JSON.stringify(input.formData),
          input.missingMandatory,
          JSON.stringify(input.validationErrors),
          input.actor.kind,
          input.actor.userId,
          input.actor.agentRunId ?? null,
          input.actor.promptHash ?? null,
          input.actor.correlationId,
        ],
      );

      await client.query(
        `INSERT INTO core.timeline_entries
           (id, tenant_id, home_id, resident_id, kind, occurred_at, summary, payload,
            incident_id, actor_kind, actor_user_id, created_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'incident', now(),
                 $4, $5::jsonb, $6::uuid, $7, $8::uuid, now())`,
        [
          input.tenantId,
          input.homeId,
          input.residentId,
          `Incident ${input.incidentId} → ${input.status} (v${input.version})`,
          JSON.stringify({ version: input.version, status: input.status }),
          input.incidentId,
          input.actor.kind,
          input.actor.userId,
        ],
      );

      if (input.status === 'rejected') {
        await client.query(
          `UPDATE core.workflow_instances
              SET status = 'completed', updated_at = now()
            WHERE workflow_kind = 'incident'
              AND subject_type = 'incident'
              AND subject_id = $1::uuid`,
          [input.incidentId],
        );
      }

      return { version: input.version, versionId };
    },
  );
}

// 4 ──────────────────────────────────────────────────────────────────────────
// routeForApproval: flip incident.status to awaiting_approval. The actual
// approver gate lives on the controller (RolesGuard).
export async function routeForApproval(input: RouteForApprovalInput): Promise<void> {
  await withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      await client.query(
        `UPDATE core.incidents
            SET status = 'awaiting_approval'::"core"."IncidentStatus",
                updated_at = now()
          WHERE id = $1::uuid`,
        [input.incidentId],
      );
      if (input.immediateRisk) {
        const outboxId = stableUuid(`incident:${input.incidentId}:immediate-risk`);
        await client.query(
          `INSERT INTO core.outbox
             (id, tenant_id, home_id, topic, payload, status, attempts, available_at, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'novu.incident.immediate_risk', $4::jsonb,
             'pending', 0, now(), now())
           ON CONFLICT (id) DO NOTHING`,
          [
            outboxId,
            input.tenantId,
            input.homeId,
            JSON.stringify({
              incidentId: input.incidentId,
              residentId: input.residentId,
              safeguarding: input.safeguarding,
              version: input.version,
            }),
          ],
        );
      }
    },
  );
}

// 5 ──────────────────────────────────────────────────────────────────────────
// exportPdf: render via Gotenberg, store in MinIO, then mark the incident row
// as exported with the object key. A presigned download URL is minted on
// demand by GET /incidents/:id/download on the api side.
export async function exportPdf(input: ExportPdfInput): Promise<ExportPdfResult> {
  const { html } = renderIncidentHtml(input);
  const pdf = await createGotenbergConverter().htmlToPdf(html);
  const bucket = exportBucketName();
  const objectKey = objectKeyFor(input);

  const store = createMinioStore();
  await store.ensureBucket(bucket);
  await store.putObject(bucket, objectKey, pdf, 'application/pdf');

  const sha256 = sha256Hex(pdf);

  await withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      await client.query(
        `UPDATE core.incidents
            SET status = 'exported'::"core"."IncidentStatus",
                exported_at = now(),
                export_object_key = $2,
                updated_at = now()
          WHERE id = $1::uuid`,
        [input.incidentId, objectKey],
      );
      await client.query(
        `UPDATE core.workflow_instances
            SET status = 'completed', updated_at = now()
          WHERE workflow_kind = 'incident'
            AND subject_type = 'incident'
            AND subject_id = $1::uuid`,
        [input.incidentId],
      );
    },
  );

  return { objectKey, sha256, sizeBytes: pdf.length };
}

// 6 ──────────────────────────────────────────────────────────────────────────
// writeAuditEvent: workflow-lifecycle events that aren't auto-captured by the
// DB triggers (agent run boundaries, approval routed, export attempted/failed).
export async function writeAuditEvent(input: WriteAuditEventInput): Promise<void> {
  await withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      await client.query(
        `INSERT INTO audit.events
          (id, tenant_id, home_id, action, subject_type, subject_id,
            actor_kind, actor_user_id, agent_run_id, prompt_hash,
          correlation_id, metadata, occurred_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'incident', $4::uuid,
                 $5, $6::uuid, $7, $8, $9, $10::jsonb, now())`,
        [
          input.tenantId,
          input.homeId,
          input.eventType,
          input.incidentId,
          input.actor.kind,
          input.actor.userId,
          input.actor.agentRunId ?? null,
          input.actor.promptHash ?? null,
          input.actor.correlationId,
          JSON.stringify(input.payload),
        ],
      );
    },
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('Unable to derive incident outbox id.');
  }
  bytes[6] = (versionByte & 0x0f) | 0x40;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}
