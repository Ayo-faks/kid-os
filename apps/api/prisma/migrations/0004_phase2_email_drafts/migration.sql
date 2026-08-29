-- Phase 2 §2 — email drafts. Hermes drafts emails; nothing in CareOS sends
-- them. Sensitive drafts route to needs_review. RLS + append-only audit cover
-- inserts, status changes, and review attribution.

CREATE TYPE "core"."EmailDraftStatus" AS ENUM ('draft', 'needs_review', 'approved', 'rejected', 'sent_stub');
CREATE TYPE "core"."EmailSensitivity" AS ENUM ('routine', 'sensitive');
CREATE TYPE "core"."EmailSourceKind" AS ENUM ('incident', 'handover', 'general');

CREATE TABLE "core"."email_drafts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "workflow_id" TEXT,
    "source_kind" "core"."EmailSourceKind" NOT NULL,
    "source_id" UUID,
    "source_summary" TEXT NOT NULL,
    "recipient_name" TEXT,
    "recipient_email" TEXT NOT NULL,
    "recipient_role" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sensitivity" "core"."EmailSensitivity" NOT NULL DEFAULT 'routine',
    "sensitivity_reasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "status" "core"."EmailDraftStatus" NOT NULL DEFAULT 'draft',
    "prompt_hash" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_drafts_workflow_id_key" ON "core"."email_drafts"("workflow_id");
CREATE INDEX "email_drafts_tenant_id_home_id_created_at_idx" ON "core"."email_drafts"("tenant_id", "home_id", "created_at");
CREATE INDEX "email_drafts_status_idx" ON "core"."email_drafts"("status");
CREATE INDEX "email_drafts_source_kind_source_id_idx" ON "core"."email_drafts"("source_kind", "source_id");

ALTER TABLE "core"."email_drafts"
    ADD CONSTRAINT "email_drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."email_drafts"
    ADD CONSTRAINT "email_drafts_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."email_drafts"
    ADD CONSTRAINT "email_drafts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."email_drafts"
    ADD CONSTRAINT "email_drafts_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "core"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "core"."email_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."email_drafts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "email_drafts_tenant_home_isolation" ON "core"."email_drafts"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION "audit"."on_email_drafts_change"()
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
            CASE NEW.status::text
                WHEN 'needs_review' THEN 'email_draft.routed_for_review'
                ELSE 'email_draft.created'
            END,
            'email_draft',
            NEW.id,
            jsonb_build_object(
                'source_kind', NEW.source_kind,
                'source_id', NEW.source_id,
                'recipient_email', NEW.recipient_email,
                'sensitivity', NEW.sensitivity,
                'status', NEW.status,
                'workflow_id', NEW.workflow_id,
                'created_by_user_id', NEW.created_by_user_id
            )
        );
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_action := CASE NEW.status::text
            WHEN 'needs_review' THEN 'email_draft.routed_for_review'
            WHEN 'approved'     THEN 'email_draft.approved'
            WHEN 'rejected'     THEN 'email_draft.rejected'
            WHEN 'sent_stub'    THEN 'email_draft.sent_stub'
            ELSE                     'email_draft.status_changed'
        END;
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            v_action,
            'email_draft',
            NEW.id,
            jsonb_build_object(
                'status', jsonb_build_object('before', OLD.status, 'after', NEW.status),
                'reviewed_by_user_id', NEW.reviewed_by_user_id
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "email_drafts_audit_ins"
AFTER INSERT ON "core"."email_drafts"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_email_drafts_change"();

CREATE TRIGGER "email_drafts_audit_upd"
AFTER UPDATE ON "core"."email_drafts"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_email_drafts_change"();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."email_drafts" TO "careos_app";
