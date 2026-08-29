-- Phase 3 §2 (D3 slice 3) — overdue handover reminders.
--
-- Adds `handover_due_reminder_sent_at` to `core.shifts` so the scheduled
-- sweep can flag a shift exactly once when its end time has passed and
-- no handover_record has been written. The existing `shifts_system_read`
-- policy (added in 0009) already lets the system actor SELECT across
-- tenants; writes still flow through tenant context so RLS WITH CHECK
-- and audit attribution are unchanged.

ALTER TABLE "core"."shifts"
    ADD COLUMN "handover_due_reminder_sent_at" TIMESTAMP(3) NULL;

CREATE INDEX "shifts_handover_due_reminder_sweep_idx"
    ON "core"."shifts" ("ends_at")
    WHERE "handover_due_reminder_sent_at" IS NULL;

CREATE OR REPLACE FUNCTION "audit"."on_shift_handover_due_reminder_dispatch"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.handover_due_reminder_sent_at IS NOT NULL
       AND OLD.handover_due_reminder_sent_at IS NULL THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'shift.handover_due_reminder_dispatched',
            'shift',
            NEW.id,
            jsonb_build_object(
                'ends_at', NEW.ends_at,
                'required_role', NEW.required_role
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "shifts_handover_due_reminder_audit_upd"
AFTER UPDATE OF "handover_due_reminder_sent_at" ON "core"."shifts"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_shift_handover_due_reminder_dispatch"();
