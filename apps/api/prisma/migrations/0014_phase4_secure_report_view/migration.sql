-- Phase 4 stabilization — secure report view + active-row read indexes.
--
-- Forward-only repair for migration 0013:
--   * SECURITY INVOKER makes the view execute under careos_app so the
--     underlying incidents/form_templates RLS policies remain authoritative;
--   * incident type comes from the registered form-template identity instead
--     of a form_data field that shipped schemas do not define;
--   * soft-deleted incidents are excluded from all report aggregates.

CREATE OR REPLACE VIEW "core"."v_incidents_reportable"
WITH (security_invoker = true) AS
SELECT
    i.id,
    i.tenant_id,
    i.home_id,
    i.resident_id,
    i.status,
    i.created_at,
    i.approved_at,
    i.exported_at,
    COALESCE(NULLIF(ft.template_id, ''), 'uncategorised') AS incident_type,
    date_trunc('month', i.created_at) AS month_bucket
FROM "core"."incidents" i
LEFT JOIN "core"."form_templates" ft
    ON ft.id = i.form_template_id
WHERE i.soft_deleted_at IS NULL;

GRANT SELECT ON "core"."v_incidents_reportable" TO "careos_app";

-- Keep common active-row lookups efficient as retention volume grows.
CREATE INDEX IF NOT EXISTS "incidents_active_tenant_home_created_idx"
    ON "core"."incidents" (tenant_id, home_id, created_at DESC)
    WHERE soft_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS "handover_records_active_tenant_home_created_idx"
    ON "core"."handover_records" (tenant_id, home_id, created_at DESC)
    WHERE soft_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS "email_drafts_active_tenant_home_created_idx"
    ON "core"."email_drafts" (tenant_id, home_id, created_at DESC)
    WHERE soft_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS "attachments_active_tenant_home_created_idx"
    ON "core"."attachments" (tenant_id, home_id, created_at DESC)
    WHERE soft_deleted_at IS NULL;
