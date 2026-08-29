-- Phase 2 §1 — handovers and the minimal shift assignment surface needed to
-- route follow-up tasks to the next shift's assignees.

CREATE TYPE "core"."ShiftAssignmentState" AS ENUM ('tentative', 'confirmed', 'published');
CREATE TYPE "core"."HandoverStatus" AS ENUM ('processing', 'completed', 'failed');

CREATE TABLE "core"."shifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "required_role" TEXT NOT NULL,
    "min_headcount" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."shift_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "state" "core"."ShiftAssignmentState" NOT NULL DEFAULT 'tentative',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."handover_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "workflow_id" TEXT,
    "status" "core"."HandoverStatus" NOT NULL DEFAULT 'processing',
    "source_text" TEXT NOT NULL,
    "transcript_object_key" TEXT,
    "structured_payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "handover_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."handover_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "handover_record_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handover_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shifts_tenant_id_home_id_starts_at_idx" ON "core"."shifts"("tenant_id", "home_id", "starts_at");
CREATE UNIQUE INDEX "shift_assignments_shift_id_user_id_key" ON "core"."shift_assignments"("shift_id", "user_id");
CREATE INDEX "shift_assignments_tenant_id_home_id_shift_id_idx" ON "core"."shift_assignments"("tenant_id", "home_id", "shift_id");
CREATE UNIQUE INDEX "handover_records_workflow_id_key" ON "core"."handover_records"("workflow_id");
CREATE INDEX "handover_records_tenant_id_home_id_created_at_idx" ON "core"."handover_records"("tenant_id", "home_id", "created_at");
CREATE INDEX "handover_records_shift_id_idx" ON "core"."handover_records"("shift_id");
CREATE UNIQUE INDEX "handover_tasks_handover_record_id_task_id_key" ON "core"."handover_tasks"("handover_record_id", "task_id");
CREATE UNIQUE INDEX "handover_tasks_task_id_key" ON "core"."handover_tasks"("task_id");
CREATE INDEX "handover_tasks_tenant_id_home_id_idx" ON "core"."handover_tasks"("tenant_id", "home_id");

ALTER TABLE "core"."shifts" ADD CONSTRAINT "shifts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."shifts" ADD CONSTRAINT "shifts_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "core"."shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core"."shift_assignments" ADD CONSTRAINT "shift_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core"."handover_records" ADD CONSTRAINT "handover_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."handover_records" ADD CONSTRAINT "handover_records_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."handover_records" ADD CONSTRAINT "handover_records_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "core"."shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."handover_records" ADD CONSTRAINT "handover_records_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."handover_tasks" ADD CONSTRAINT "handover_tasks_handover_record_id_fkey" FOREIGN KEY ("handover_record_id") REFERENCES "core"."handover_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core"."handover_tasks" ADD CONSTRAINT "handover_tasks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "core"."tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "core"."shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shifts_tenant_home_isolation" ON "core"."shifts"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."shift_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."shift_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "shift_assignments_tenant_home_isolation" ON "core"."shift_assignments"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."handover_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."handover_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "handover_records_tenant_home_isolation" ON "core"."handover_records"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."handover_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."handover_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "handover_tasks_tenant_home_isolation" ON "core"."handover_tasks"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION "audit"."on_handover_records_change"()
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
            'handover.created',
            'handover',
            NEW.id,
            jsonb_build_object(
                'shift_id', NEW.shift_id,
                'status', NEW.status,
                'workflow_id', NEW.workflow_id,
                'created_by_user_id', NEW.created_by_user_id
            )
        );
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_action := CASE NEW.status::text
            WHEN 'completed' THEN 'handover.completed'
            WHEN 'failed'    THEN 'handover.failed'
            ELSE                  'handover.status_changed'
        END;
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            v_action,
            'handover',
            NEW.id,
            jsonb_build_object('status', jsonb_build_object('before', OLD.status, 'after', NEW.status))
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "handover_records_audit_ins"
AFTER INSERT ON "core"."handover_records"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_handover_records_change"();

CREATE TRIGGER "handover_records_audit_upd"
AFTER UPDATE ON "core"."handover_records"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_handover_records_change"();

CREATE OR REPLACE FUNCTION "audit"."on_handover_tasks_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "audit"."record_event"(
        NEW.tenant_id,
        NEW.home_id,
        'handover_task.created',
        'handover_task',
        NEW.id,
        jsonb_build_object('handover_record_id', NEW.handover_record_id, 'task_id', NEW.task_id)
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER "handover_tasks_audit_ins"
AFTER INSERT ON "core"."handover_tasks"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_handover_tasks_change"();

CREATE OR REPLACE FUNCTION "audit"."on_tasks_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'task.created',
            'task',
            NEW.id,
            jsonb_build_object(
                'resident_id', NEW.resident_id,
                'title', NEW.title,
                'assigned_user_id', NEW.assigned_user_id,
                'due_at', NEW.due_at
            )
        );
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'task.status_changed',
            'task',
            NEW.id,
            jsonb_build_object('status', jsonb_build_object('before', OLD.status, 'after', NEW.status))
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "tasks_audit_ins"
AFTER INSERT ON "core"."tasks"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_tasks_change"();

CREATE TRIGGER "tasks_audit_upd"
AFTER UPDATE ON "core"."tasks"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_tasks_change"();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    "core"."shifts",
    "core"."shift_assignments",
    "core"."handover_records",
    "core"."handover_tasks"
TO "careos_app";