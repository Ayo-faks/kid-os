-- One explicit external safeguarding contact per home. The address is domain
-- data and is deliberately excluded from audit event payloads.

ALTER TABLE "core"."homes"
  ADD COLUMN "safeguarding_contact_name" TEXT,
  ADD COLUMN "safeguarding_contact_email" TEXT,
  ADD CONSTRAINT "homes_safeguarding_contact_pair_check" CHECK (
    ("safeguarding_contact_name" IS NULL AND "safeguarding_contact_email" IS NULL)
    OR (
      length(btrim("safeguarding_contact_name")) > 0
      AND length(btrim("safeguarding_contact_email")) > 0
    )
  );

CREATE OR REPLACE FUNCTION "audit"."on_home_safeguarding_contact_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_before_configured boolean;
  v_after_configured boolean;
BEGIN
  IF NEW.safeguarding_contact_name IS NOT DISTINCT FROM OLD.safeguarding_contact_name
     AND NEW.safeguarding_contact_email IS NOT DISTINCT FROM OLD.safeguarding_contact_email THEN
    RETURN NEW;
  END IF;

  v_before_configured := OLD.safeguarding_contact_name IS NOT NULL
    AND OLD.safeguarding_contact_email IS NOT NULL;
  v_after_configured := NEW.safeguarding_contact_name IS NOT NULL
    AND NEW.safeguarding_contact_email IS NOT NULL;

  PERFORM "audit"."record_event"(
    NEW.tenant_id,
    NEW.id,
    'home.safeguarding_contact_changed',
    'home',
    NEW.id,
    jsonb_build_object(
      'configured', jsonb_build_object(
        'before', v_before_configured,
        'after', v_after_configured
      )
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "homes_safeguarding_contact_audit_upd"
AFTER UPDATE OF "safeguarding_contact_name", "safeguarding_contact_email"
ON "core"."homes"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_home_safeguarding_contact_change"();