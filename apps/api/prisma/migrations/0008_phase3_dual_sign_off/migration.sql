-- Phase 3 §4 — dual_sign_off wiring. Approvals now carry an explicit
-- `signatures_required` threshold (1 = confirm, 2 = dual_sign_off) and a
-- `signatures` JSONB array recording each distinct approver. The status
-- flips terminal only when an approver rejects (one veto ends it) or the
-- accumulated approvals reach `signatures_required`.

ALTER TABLE "core"."approvals"
    ADD COLUMN "signatures_required" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "signatures" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "core"."approvals"
    ADD CONSTRAINT "approvals_signatures_required_check"
    CHECK ("signatures_required" IN (1, 2));

ALTER TABLE "core"."approvals"
    ADD CONSTRAINT "approvals_signatures_is_array"
    CHECK (jsonb_typeof("signatures") = 'array');

CREATE OR REPLACE FUNCTION "audit"."on_approvals_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_action text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'approval.created',
            'approval',
            NEW.id,
            jsonb_build_object(
                'subject_type', NEW.subject_type,
                'subject_id', NEW.subject_id,
                'status', NEW.status,
                'workflow_id', NEW.workflow_id,
                'requested_by_user_id', NEW.requested_by_user_id,
                'signatures_required', NEW.signatures_required
            )
        );
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_action := CASE NEW.status::text
            WHEN 'approved' THEN 'approval.approved'
            WHEN 'rejected' THEN 'approval.rejected'
            ELSE                 'approval.status_changed'
        END;

        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            v_action,
            'approval',
            NEW.id,
            jsonb_build_object(
                'status', jsonb_build_object('before', OLD.status, 'after', NEW.status),
                'subject_type', NEW.subject_type,
                'subject_id', NEW.subject_id,
                'decided_by_user_id', NEW.decided_by_user_id,
                'decision_reason', NEW.decision_reason,
                'signatures_required', NEW.signatures_required,
                'signatures_recorded', jsonb_array_length(NEW.signatures)
            )
        );
    ELSIF NEW.signatures IS DISTINCT FROM OLD.signatures THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'approval.signature_recorded',
            'approval',
            NEW.id,
            jsonb_build_object(
                'subject_type', NEW.subject_type,
                'subject_id', NEW.subject_id,
                'signatures_required', NEW.signatures_required,
                'signatures_recorded', jsonb_array_length(NEW.signatures)
            )
        );
    END IF;

    RETURN NEW;
END;
$$;
