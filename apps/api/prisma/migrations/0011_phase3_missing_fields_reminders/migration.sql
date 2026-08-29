-- Phase 3 §2 (D3 slice 5) — nightly missing-mandatory-fields audit.
--
-- Adds `missing_fields_reminder_sent_at` to `core.incidents` so the
-- scheduled audit sweep can dispatch exactly-once reminders for drafts
-- that still have unfilled mandatory fields. Mirrors the
-- shift-reminder / handover-due-reminder cron pattern: a partial index
-- for the sweep, a `system` SELECT carve-out so the worker can scan
-- cross-tenant without bypassing writes, and an audit trigger emitting
-- `incident.missing_fields_reminder_dispatched` on NULL → NOW flip.

ALTER TABLE "core"."incidents"
    ADD COLUMN "missing_fields_reminder_sent_at" TIMESTAMP(3) NULL;

CREATE INDEX "incidents_missing_fields_sweep_idx"
    ON "core"."incidents" ("created_at")
    WHERE "missing_fields_reminder_sent_at" IS NULL;

CREATE POLICY "incidents_system_read" ON "core"."incidents"
    AS PERMISSIVE
    FOR SELECT
    USING (
        current_setting('app.current_actor_kind', true) = 'system'
    );

CREATE OR REPLACE FUNCTION "audit"."on_incident_missing_fields_reminder_dispatch"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.missing_fields_reminder_sent_at IS NOT NULL
       AND OLD.missing_fields_reminder_sent_at IS NULL THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'incident.missing_fields_reminder_dispatched',
            'incident',
            NEW.id,
            jsonb_build_object(
                'status',         NEW.status,
                'current_version', NEW.current_version,
                'resident_id',    NEW.resident_id
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "incidents_missing_fields_reminder_audit_upd"
AFTER UPDATE OF "missing_fields_reminder_sent_at" ON "core"."incidents"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_incident_missing_fields_reminder_dispatch"();
