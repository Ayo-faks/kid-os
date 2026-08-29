-- Phase 3 §2 (D3 wiring) — pre-shift handover reminders.
--
-- Adds `reminder_sent_at` to `core.shifts` so the scheduled sweep can
-- mark a shift as reminded exactly once (race-free via an idempotent
-- UPDATE that only flips NULL → NOW()). The sweep workflow runs under a
-- `system` actor and needs cross-tenant SELECT, so we add a second RLS
-- policy alongside the existing tenant-home isolation policy. Writes
-- (markShiftReminderSent) still flow through tenant context so RLS
-- WITH CHECK and audit attribution are unchanged.

ALTER TABLE "core"."shifts"
    ADD COLUMN "reminder_sent_at" TIMESTAMP(3) NULL;

CREATE INDEX "shifts_reminder_sweep_idx"
    ON "core"."shifts" ("starts_at")
    WHERE "reminder_sent_at" IS NULL;

-- Read-only carve-out for the worker sweep. The activity sets
-- `app.current_actor_kind = 'system'` (with tenant_id / home_id left
-- blank) so RLS lets it scan upcoming shifts across tenants. Writes are
-- still blocked because no policy applies to WITH CHECK for system rows.
CREATE POLICY "shifts_system_read" ON "core"."shifts"
    AS PERMISSIVE
    FOR SELECT
    USING (
        current_setting('app.current_actor_kind', true) = 'system'
    );

-- Append a dedicated audit action when the sweep records a reminder
-- dispatch. Keeping this in its own trigger leaves the (currently
-- absent) generic shift trigger out of scope; the activity sets the
-- correlation_id so the trace links back to the workflow.
CREATE OR REPLACE FUNCTION "audit"."on_shift_reminder_dispatch"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.reminder_sent_at IS NOT NULL
       AND OLD.reminder_sent_at IS NULL THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'shift.reminder_dispatched',
            'shift',
            NEW.id,
            jsonb_build_object(
                'starts_at', NEW.starts_at,
                'required_role', NEW.required_role,
                'min_headcount', NEW.min_headcount
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "shifts_reminder_audit_upd"
AFTER UPDATE OF "reminder_sent_at" ON "core"."shifts"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_shift_reminder_dispatch"();
