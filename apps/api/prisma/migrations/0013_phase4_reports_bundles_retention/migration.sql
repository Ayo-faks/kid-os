-- Phase 4 §1-3 — Reporting, serious-incident export bundles, retention.
--
-- Adds:
--   * a SQL view `core.v_incidents_reportable` that exposes per-incident
--     aggregation-friendly columns (incident_type, status, created_at month)
--     so the reports module can run KQL-style aggregates without leaking
--     incident_versions internals;
--   * `core.export_bundles` for Ofsted-style zipped PDF + JSON audit trail
--     bundles, with RLS + append-only audit triggers;
--   * `core.retention_policies` + `core.retention_runs` for configurable
--     per-record-type soft-delete + crypto-shred retention with audit;
--   * soft-delete columns on `core.incidents`, `core.handover_records`,
--     `core.email_drafts`, `core.attachments` (so the retention sweep can
--     mark records without dropping rows) and a `crypto_shredded_at`
--     marker on `core.attachments` recording that the underlying object
--     storage key has been shredded.

-- ─── reports view ───────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW "core"."v_incidents_reportable" AS
SELECT
    i.id,
    i.tenant_id,
    i.home_id,
    i.resident_id,
    i.status,
    i.created_at,
    i.approved_at,
    i.exported_at,
    -- Pull `incident_type` out of the current version's form_data if present;
    -- fallback to the empty string so GROUP BY never sees NULL.
    COALESCE(
        NULLIF(v.form_data ->> 'incident_type', ''),
        'uncategorised'
    ) AS incident_type,
    date_trunc('month', i.created_at) AS month_bucket
FROM "core"."incidents" i
LEFT JOIN "core"."incident_versions" v
    ON v.incident_id = i.id AND v.version = i.current_version;

-- ─── export bundles ────────────────────────────────────────────────────────

CREATE TYPE "core"."ExportBundleStatus" AS ENUM (
    'pending',
    'building',
    'ready',
    'failed'
);

CREATE TABLE "core"."export_bundles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "workflow_id" TEXT,
    "status" "core"."ExportBundleStatus" NOT NULL DEFAULT 'pending',
    "object_key" TEXT,
    "manifest_sha256" TEXT,
    "signature" TEXT,
    "signature_algorithm" TEXT,
    "size_bytes" INTEGER,
    "retain_until" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_bundles_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "core"."export_bundles"
    ADD CONSTRAINT "export_bundles_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE "core"."export_bundles"
    ADD CONSTRAINT "export_bundles_home_id_fkey"
    FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT;

ALTER TABLE "core"."export_bundles"
    ADD CONSTRAINT "export_bundles_incident_id_fkey"
    FOREIGN KEY ("incident_id") REFERENCES "core"."incidents"("id") ON DELETE RESTRICT;

ALTER TABLE "core"."export_bundles"
    ADD CONSTRAINT "export_bundles_requested_by_user_id_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "export_bundles_workflow_id_key" ON "core"."export_bundles"("workflow_id");
CREATE INDEX "export_bundles_tenant_home_status_idx" ON "core"."export_bundles"("tenant_id", "home_id", "status");
CREATE INDEX "export_bundles_incident_idx" ON "core"."export_bundles"("incident_id");

ALTER TABLE "core"."export_bundles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."export_bundles" FORCE ROW LEVEL SECURITY;

CREATE POLICY "export_bundles_tenant_home_isolation" ON "core"."export_bundles"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION "audit"."on_export_bundles_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "audit"."record_event"(
        NEW.tenant_id,
        NEW.home_id,
        'export_bundle.requested',
        'export_bundle',
        NEW.id,
        jsonb_build_object(
            'incident_id', NEW.incident_id,
            'status', NEW.status,
            'requested_by_user_id', NEW.requested_by_user_id
        )
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER "export_bundles_audit_ins"
AFTER INSERT ON "core"."export_bundles"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_export_bundles_insert"();

CREATE OR REPLACE FUNCTION "audit"."on_export_bundles_status_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            CASE NEW.status
                WHEN 'ready' THEN 'export_bundle.completed'
                WHEN 'failed' THEN 'export_bundle.failed'
                ELSE 'export_bundle.status_changed'
            END,
            'export_bundle',
            NEW.id,
            jsonb_build_object(
                'from_status', OLD.status,
                'to_status', NEW.status,
                'object_key', NEW.object_key,
                'manifest_sha256', NEW.manifest_sha256,
                'signature_algorithm', NEW.signature_algorithm,
                'size_bytes', NEW.size_bytes,
                'retain_until', NEW.retain_until,
                'failure_reason', NEW.failure_reason
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "export_bundles_audit_upd"
AFTER UPDATE ON "core"."export_bundles"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_export_bundles_status_change"();

-- ─── retention policies + runs ─────────────────────────────────────────────

CREATE TYPE "core"."RetentionRecordType" AS ENUM (
    'incident',
    'handover_record',
    'email_draft',
    'attachment'
);

CREATE TYPE "core"."RetentionAction" AS ENUM (
    'soft_delete',
    'crypto_shred'
);

CREATE TABLE "core"."retention_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "record_type" "core"."RetentionRecordType" NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "action" "core"."RetentionAction" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "retention_policies_retention_days_check" CHECK ("retention_days" >= 0)
);

ALTER TABLE "core"."retention_policies"
    ADD CONSTRAINT "retention_policies_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "retention_policies_tenant_type_key"
    ON "core"."retention_policies"("tenant_id", "record_type");

ALTER TABLE "core"."retention_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."retention_policies" FORCE ROW LEVEL SECURITY;

-- Retention policies are tenant-scoped (no home), so the policy here is
-- tenant-only. System-context reads (used by the retention sweep workflow)
-- bypass home isolation but still require the tenant GUC.
CREATE POLICY "retention_policies_tenant_isolation" ON "core"."retention_policies"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    );

CREATE POLICY "retention_policies_system_read" ON "core"."retention_policies"
    FOR SELECT
    USING (
        current_setting('app.current_actor_kind', true) = 'system'
    );

CREATE TABLE "core"."retention_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "record_type" "core"."RetentionRecordType" NOT NULL,
    "action" "core"."RetentionAction" NOT NULL,
    "scanned_count" INTEGER NOT NULL DEFAULT 0,
    "affected_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "failure_reason" TEXT,

    CONSTRAINT "retention_runs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "core"."retention_runs"
    ADD CONSTRAINT "retention_runs_policy_id_fkey"
    FOREIGN KEY ("policy_id") REFERENCES "core"."retention_policies"("id") ON DELETE RESTRICT;

ALTER TABLE "core"."retention_runs"
    ADD CONSTRAINT "retention_runs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT;

CREATE INDEX "retention_runs_tenant_started_idx" ON "core"."retention_runs"("tenant_id", "started_at");

ALTER TABLE "core"."retention_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."retention_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "retention_runs_tenant_isolation" ON "core"."retention_runs"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    );

CREATE POLICY "retention_runs_system_rw" ON "core"."retention_runs"
    FOR ALL
    USING (current_setting('app.current_actor_kind', true) = 'system')
    WITH CHECK (current_setting('app.current_actor_kind', true) = 'system');

-- ─── soft-delete + crypto-shred markers ───────────────────────────────────

ALTER TABLE "core"."incidents"
    ADD COLUMN "soft_deleted_at" TIMESTAMP(3),
    ADD COLUMN "retention_policy_id" UUID;

ALTER TABLE "core"."handover_records"
    ADD COLUMN "soft_deleted_at" TIMESTAMP(3),
    ADD COLUMN "retention_policy_id" UUID;

ALTER TABLE "core"."email_drafts"
    ADD COLUMN "soft_deleted_at" TIMESTAMP(3),
    ADD COLUMN "retention_policy_id" UUID;

ALTER TABLE "core"."attachments"
    ADD COLUMN "soft_deleted_at" TIMESTAMP(3),
    ADD COLUMN "crypto_shredded_at" TIMESTAMP(3),
    ADD COLUMN "retention_policy_id" UUID;

CREATE INDEX "incidents_soft_deleted_idx" ON "core"."incidents"("tenant_id", "home_id", "soft_deleted_at");
CREATE INDEX "attachments_crypto_shredded_idx" ON "core"."attachments"("tenant_id", "home_id", "crypto_shredded_at");

-- Audit triggers for retention markers — every retention decision writes an
-- audit row so retention can never silently bypass the audit log.

CREATE OR REPLACE FUNCTION "audit"."on_incident_retention_applied"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.soft_deleted_at IS NOT NULL
       AND (OLD.soft_deleted_at IS NULL OR OLD.soft_deleted_at IS DISTINCT FROM NEW.soft_deleted_at) THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'retention.applied',
            'incident',
            NEW.id,
            jsonb_build_object(
                'action', 'soft_delete',
                'retention_policy_id', NEW.retention_policy_id,
                'soft_deleted_at', NEW.soft_deleted_at
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "incidents_retention_audit_upd"
AFTER UPDATE OF "soft_deleted_at" ON "core"."incidents"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_incident_retention_applied"();

CREATE OR REPLACE FUNCTION "audit"."on_handover_retention_applied"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.soft_deleted_at IS NOT NULL
       AND (OLD.soft_deleted_at IS NULL OR OLD.soft_deleted_at IS DISTINCT FROM NEW.soft_deleted_at) THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'retention.applied',
            'handover_record',
            NEW.id,
            jsonb_build_object(
                'action', 'soft_delete',
                'retention_policy_id', NEW.retention_policy_id,
                'soft_deleted_at', NEW.soft_deleted_at
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "handover_records_retention_audit_upd"
AFTER UPDATE OF "soft_deleted_at" ON "core"."handover_records"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_handover_retention_applied"();

CREATE OR REPLACE FUNCTION "audit"."on_email_draft_retention_applied"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.soft_deleted_at IS NOT NULL
       AND (OLD.soft_deleted_at IS NULL OR OLD.soft_deleted_at IS DISTINCT FROM NEW.soft_deleted_at) THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'retention.applied',
            'email_draft',
            NEW.id,
            jsonb_build_object(
                'action', 'soft_delete',
                'retention_policy_id', NEW.retention_policy_id,
                'soft_deleted_at', NEW.soft_deleted_at
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_drafts_retention_audit_upd"
AFTER UPDATE OF "soft_deleted_at" ON "core"."email_drafts"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_email_draft_retention_applied"();

CREATE OR REPLACE FUNCTION "audit"."on_attachment_retention_applied"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.crypto_shredded_at IS NOT NULL
       AND (OLD.crypto_shredded_at IS NULL OR OLD.crypto_shredded_at IS DISTINCT FROM NEW.crypto_shredded_at) THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'retention.applied',
            'attachment',
            NEW.id,
            jsonb_build_object(
                'action', 'crypto_shred',
                'retention_policy_id', NEW.retention_policy_id,
                'crypto_shredded_at', NEW.crypto_shredded_at,
                'object_key', NEW.object_key
            )
        );
    ELSIF NEW.soft_deleted_at IS NOT NULL
       AND (OLD.soft_deleted_at IS NULL OR OLD.soft_deleted_at IS DISTINCT FROM NEW.soft_deleted_at) THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'retention.applied',
            'attachment',
            NEW.id,
            jsonb_build_object(
                'action', 'soft_delete',
                'retention_policy_id', NEW.retention_policy_id,
                'soft_deleted_at', NEW.soft_deleted_at
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "attachments_retention_audit_upd"
AFTER UPDATE OF "soft_deleted_at", "crypto_shredded_at" ON "core"."attachments"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_attachment_retention_applied"();
