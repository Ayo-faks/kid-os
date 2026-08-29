-- Phase 2 §3 — generic approvals service. Approvals are polymorphic by
-- subject_type/subject_id and currently route sensitive email drafts.

CREATE TYPE "core"."ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE "core"."approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "workflow_id" TEXT,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status" "core"."ApprovalStatus" NOT NULL DEFAULT 'pending',
    "requested_by_user_id" UUID NOT NULL,
    "decided_by_user_id" UUID,
    "decision_reason" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "approvals_workflow_id_key" ON "core"."approvals"("workflow_id");
CREATE UNIQUE INDEX "approvals_subject_key" ON "core"."approvals"("tenant_id", "home_id", "subject_type", "subject_id");
CREATE INDEX "approvals_tenant_id_home_id_status_created_at_idx" ON "core"."approvals"("tenant_id", "home_id", "status", "created_at");
CREATE INDEX "approvals_subject_type_subject_id_idx" ON "core"."approvals"("subject_type", "subject_id");

ALTER TABLE "core"."approvals"
    ADD CONSTRAINT "approvals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."approvals"
    ADD CONSTRAINT "approvals_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."approvals"
    ADD CONSTRAINT "approvals_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."approvals"
    ADD CONSTRAINT "approvals_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "core"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "core"."approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."approvals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "approvals_tenant_home_isolation" ON "core"."approvals"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

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
                'requested_by_user_id', NEW.requested_by_user_id
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
                'decision_reason', NEW.decision_reason
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "approvals_audit_ins"
AFTER INSERT ON "core"."approvals"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_approvals_change"();

CREATE TRIGGER "approvals_audit_upd"
AFTER UPDATE ON "core"."approvals"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_approvals_change"();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."approvals" TO "careos_app";