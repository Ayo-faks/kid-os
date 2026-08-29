-- Phase 4 stabilization — role-aware generic approvals.
--
-- Extends the numeric threshold from migration 0008 with exact role coverage,
-- constrains polymorphic subjects to the implemented types, and validates the
-- append-only signature payload shape. Existing dual-sign-off rows are
-- backfilled to manager + safeguarding_lead; single-signature rows require a
-- manager.

ALTER TABLE "core"."approvals"
    ADD COLUMN "required_roles" TEXT[] NOT NULL DEFAULT ARRAY['manager']::text[];

UPDATE "core"."approvals"
SET "required_roles" = CASE
    WHEN "signatures_required" = 2
        THEN ARRAY['manager', 'safeguarding_lead']::text[]
    ELSE ARRAY['manager']::text[]
END;

CREATE OR REPLACE FUNCTION "core"."approval_required_roles_valid"(
    roles text[],
    signatures_required integer
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    role text;
    seen text[] := ARRAY[]::text[];
BEGIN
    IF cardinality(roles) <> signatures_required THEN
        RETURN false;
    END IF;
    FOREACH role IN ARRAY roles
    LOOP
        IF role NOT IN ('manager', 'safeguarding_lead') OR role = ANY(seen) THEN
            RETURN false;
        END IF;
        seen := array_append(seen, role);
    END LOOP;
    RETURN true;
END;
$$;

ALTER TABLE "core"."approvals"
    ADD CONSTRAINT "approvals_subject_type_check"
        CHECK ("subject_type" IN ('email_draft', 'incident')),
    ADD CONSTRAINT "approvals_required_roles_valid_check"
        CHECK ("core"."approval_required_roles_valid"("required_roles", "signatures_required"));

CREATE OR REPLACE FUNCTION "core"."approval_signatures_valid"(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    signature jsonb;
    seen_users text[] := ARRAY[]::text[];
    user_id text;
BEGIN
    IF jsonb_typeof(value) <> 'array' THEN
        RETURN false;
    END IF;

    FOR signature IN SELECT * FROM jsonb_array_elements(value)
    LOOP
        IF jsonb_typeof(signature) <> 'object' THEN
            RETURN false;
        END IF;
        user_id := signature ->> 'userId';
        IF user_id IS NULL
           OR user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           OR user_id = ANY(seen_users)
           OR signature ->> 'decision' NOT IN ('approved', 'rejected')
           OR signature ->> 'role' NOT IN ('manager', 'safeguarding_lead', 'ops_admin')
           OR NULLIF(signature ->> 'decidedAt', '') IS NULL
        THEN
            RETURN false;
        END IF;
        seen_users := array_append(seen_users, user_id);
    END LOOP;
    RETURN true;
END;
$$;

ALTER TABLE "core"."approvals"
    DROP CONSTRAINT "approvals_signatures_is_array",
    ADD CONSTRAINT "approvals_signatures_valid_check"
        CHECK ("core"."approval_signatures_valid"("signatures"));

CREATE OR REPLACE FUNCTION "audit"."on_approvals_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_action text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id, NEW.home_id, 'approval.created', 'approval', NEW.id,
            jsonb_build_object(
                'subject_type', NEW.subject_type,
                'subject_id', NEW.subject_id,
                'status', NEW.status,
                'workflow_id', NEW.workflow_id,
                'requested_by_user_id', NEW.requested_by_user_id,
                'signatures_required', NEW.signatures_required,
                'required_roles', NEW.required_roles
            )
        );
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_action := CASE NEW.status::text
            WHEN 'approved' THEN 'approval.approved'
            WHEN 'rejected' THEN 'approval.rejected'
            ELSE 'approval.status_changed'
        END;
        PERFORM "audit"."record_event"(
            NEW.tenant_id, NEW.home_id, v_action, 'approval', NEW.id,
            jsonb_build_object(
                'status', jsonb_build_object('before', OLD.status, 'after', NEW.status),
                'subject_type', NEW.subject_type,
                'subject_id', NEW.subject_id,
                'decided_by_user_id', NEW.decided_by_user_id,
                'decision_reason', NEW.decision_reason,
                'signatures_required', NEW.signatures_required,
                'signatures_recorded', jsonb_array_length(NEW.signatures),
                'required_roles', NEW.required_roles
            )
        );
    ELSIF NEW.signatures IS DISTINCT FROM OLD.signatures THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id, NEW.home_id, 'approval.signature_recorded', 'approval', NEW.id,
            jsonb_build_object(
                'subject_type', NEW.subject_type,
                'subject_id', NEW.subject_id,
                'signatures_required', NEW.signatures_required,
                'signatures_recorded', jsonb_array_length(NEW.signatures),
                'required_roles', NEW.required_roles,
                'latest_signature', NEW.signatures -> -1
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

GRANT EXECUTE ON FUNCTION "core"."approval_required_roles_valid"(text[], integer) TO "careos_app";
GRANT EXECUTE ON FUNCTION "core"."approval_signatures_valid"(jsonb) TO "careos_app";