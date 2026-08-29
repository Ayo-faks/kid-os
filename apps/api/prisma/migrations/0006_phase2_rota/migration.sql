-- Phase 2 §4 — rota module: rota_rules for min staffing, gender mix, and
-- qualification flags, plus rota_publications recording each explicit publish.
-- Shifts and shift_assignments come from 0003_phase2_handovers and are reused
-- as-is; we only extend core.users with optional gender/qualifications metadata
-- that the deterministic solver uses to score gap proposals.

ALTER TABLE "core"."users"
    ADD COLUMN IF NOT EXISTS "qualifications" TEXT[] NOT NULL DEFAULT '{}'::text[],
    ADD COLUMN IF NOT EXISTS "gender" TEXT;

CREATE TYPE "core"."RotaRuleKind" AS ENUM ('min_staffing', 'gender_mix', 'qualification_flag');
CREATE TYPE "core"."RotaPublicationStatus" AS ENUM ('published', 'failed');

CREATE TABLE "core"."rota_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "core"."RotaRuleKind" NOT NULL,
    "parameters" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rota_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rota_rules_tenant_id_home_id_idx" ON "core"."rota_rules"("tenant_id", "home_id");
CREATE INDEX "rota_rules_kind_idx" ON "core"."rota_rules"("kind");

ALTER TABLE "core"."rota_rules"
    ADD CONSTRAINT "rota_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."rota_rules"
    ADD CONSTRAINT "rota_rules_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "core"."rota_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."rota_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rota_rules_tenant_home_isolation" ON "core"."rota_rules"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION "audit"."on_rota_rules_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'rota_rule.created',
            'rota_rule',
            NEW.id,
            jsonb_build_object('name', NEW.name, 'kind', NEW.kind, 'active', NEW.active)
        );
        RETURN NEW;
    END IF;

    PERFORM "audit"."record_event"(
        NEW.tenant_id,
        NEW.home_id,
        'rota_rule.updated',
        'rota_rule',
        NEW.id,
        jsonb_build_object(
            'active', jsonb_build_object('before', OLD.active, 'after', NEW.active),
            'name', NEW.name,
            'kind', NEW.kind
        )
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER "rota_rules_audit_ins"
AFTER INSERT ON "core"."rota_rules"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_rota_rules_change"();

CREATE TRIGGER "rota_rules_audit_upd"
AFTER UPDATE ON "core"."rota_rules"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_rota_rules_change"();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."rota_rules" TO "careos_app";

-- Each explicit publish is recorded immutably; flipping shift_assignment.state
-- to 'published' is also captured by audit on shift_assignments (Phase 0 row
-- trigger applies to all core tables). This table additionally records the
-- explicit publication act, workflow id, and the publishing user.

CREATE TABLE "core"."rota_publications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "status" "core"."RotaPublicationStatus" NOT NULL DEFAULT 'published',
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "shift_ids" UUID[] NOT NULL DEFAULT '{}'::uuid[],
    "assignment_ids" UUID[] NOT NULL DEFAULT '{}'::uuid[],
    "published_by_user_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rota_publications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rota_publications_workflow_id_key" ON "core"."rota_publications"("workflow_id");
CREATE INDEX "rota_publications_tenant_id_home_id_created_at_idx"
    ON "core"."rota_publications"("tenant_id", "home_id", "created_at");

ALTER TABLE "core"."rota_publications"
    ADD CONSTRAINT "rota_publications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."rota_publications"
    ADD CONSTRAINT "rota_publications_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."rota_publications"
    ADD CONSTRAINT "rota_publications_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "core"."rota_publications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."rota_publications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rota_publications_tenant_home_isolation" ON "core"."rota_publications"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION "audit"."on_rota_publications_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'rota.published',
            'rota_publication',
            NEW.id,
            jsonb_build_object(
                'workflow_id', NEW.workflow_id,
                'status', NEW.status,
                'period_start', NEW.period_start,
                'period_end', NEW.period_end,
                'shift_ids', NEW.shift_ids,
                'assignment_ids', NEW.assignment_ids,
                'published_by_user_id', NEW.published_by_user_id
            )
        );
        RETURN NEW;
    END IF;

    PERFORM "audit"."record_event"(
        NEW.tenant_id,
        NEW.home_id,
        'rota_publication.status_changed',
        'rota_publication',
        NEW.id,
        jsonb_build_object(
            'status', jsonb_build_object('before', OLD.status, 'after', NEW.status)
        )
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER "rota_publications_audit_ins"
AFTER INSERT ON "core"."rota_publications"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_rota_publications_change"();

CREATE TRIGGER "rota_publications_audit_upd"
AFTER UPDATE ON "core"."rota_publications"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_rota_publications_change"();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."rota_publications" TO "careos_app";

-- Flipping shift_assignments.state generates a generic audit row through the
-- Phase 0 row trigger; we add a kind-specific audit when a publish workflow
-- transitions an assignment into 'published' so timeline reporting can show it.

CREATE OR REPLACE FUNCTION "audit"."on_shift_assignments_publish"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state = 'published'::"core"."ShiftAssignmentState" THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'shift_assignment.published',
            'shift_assignment',
            NEW.id,
            jsonb_build_object(
                'shift_id', NEW.shift_id,
                'user_id', NEW.user_id,
                'state', jsonb_build_object('before', OLD.state, 'after', NEW.state)
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "shift_assignments_publish_audit"
AFTER UPDATE ON "core"."shift_assignments"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_shift_assignments_publish"();
