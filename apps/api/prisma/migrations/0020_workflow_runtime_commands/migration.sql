CREATE TYPE "core"."WorkflowRuntimeKind" AS ENUM ('temporal', 'durable');
CREATE TYPE "core"."WorkflowCommandStatus" AS ENUM (
  'pending', 'processing', 'applied', 'failed'
);

CREATE TABLE "core"."workflow_instances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "home_id" UUID NOT NULL,
  "workflow_kind" TEXT NOT NULL,
  "subject_type" TEXT NOT NULL,
  "subject_id" UUID NOT NULL,
  "runtime" "core"."WorkflowRuntimeKind" NOT NULL,
  "instance_id" TEXT NOT NULL,
  "orchestration_name" TEXT NOT NULL,
  "orchestration_version" TEXT,
  "status" TEXT NOT NULL DEFAULT 'running',
  "correlation_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_instances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_instances_id_format_check" CHECK (
    length("instance_id") BETWEEN 1 AND 100
    AND "instance_id" !~ '^@'
    AND "instance_id" ~ '^[ -~]+$'
  ),
  CONSTRAINT "workflow_instances_status_check" CHECK (
    "status" IN ('pending', 'running', 'completed', 'failed', 'terminated')
  )
);

CREATE UNIQUE INDEX "workflow_instances_instance_id_key"
  ON "core"."workflow_instances" ("instance_id");
CREATE UNIQUE INDEX "workflow_instances_subject_key"
  ON "core"."workflow_instances"
  ("tenant_id", "home_id", "workflow_kind", "subject_type", "subject_id");
CREATE INDEX "workflow_instances_runtime_status_idx"
  ON "core"."workflow_instances" ("tenant_id", "home_id", "runtime", "status");

CREATE TABLE "core"."workflow_commands" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "home_id" UUID NOT NULL,
  "workflow_instance_id" UUID NOT NULL,
  "command_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "status" "core"."WorkflowCommandStatus" NOT NULL DEFAULT 'pending',
  "failure_reason" TEXT,
  "processed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_commands_payload_object_check" CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "workflow_commands_instance_fkey"
    FOREIGN KEY ("workflow_instance_id")
    REFERENCES "core"."workflow_instances"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "workflow_commands_dedupe_key"
  ON "core"."workflow_commands" ("workflow_instance_id", "command_type", "payload_hash");
CREATE INDEX "workflow_commands_pending_idx"
  ON "core"."workflow_commands" ("tenant_id", "home_id", "status", "created_at");

ALTER TABLE "core"."workflow_instances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."workflow_instances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_instances_tenant_home_isolation"
  ON "core"."workflow_instances"
  FOR ALL
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
  );

ALTER TABLE "core"."workflow_commands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."workflow_commands" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workflow_commands_tenant_home_isolation"
  ON "core"."workflow_commands"
  FOR ALL
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION "audit"."on_workflow_instance_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "audit"."record_event"(
      NEW.tenant_id,
      NEW.home_id,
      'workflow.instance_registered',
      'workflow_instance',
      NEW.id,
      jsonb_build_object(
        'workflow_kind', NEW.workflow_kind,
        'runtime', NEW.runtime,
        'orchestration_name', NEW.orchestration_name,
        'orchestration_version', NEW.orchestration_version
      )
    );
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM "audit"."record_event"(
      NEW.tenant_id,
      NEW.home_id,
      'workflow.status_changed',
      'workflow_instance',
      NEW.id,
      jsonb_build_object(
        'workflow_kind', NEW.workflow_kind,
        'runtime', NEW.runtime,
        'status', jsonb_build_object('before', OLD.status, 'after', NEW.status)
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "workflow_instances_audit_ins"
AFTER INSERT ON "core"."workflow_instances"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_workflow_instance_change"();
CREATE TRIGGER "workflow_instances_audit_upd"
AFTER UPDATE ON "core"."workflow_instances"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_workflow_instance_change"();

CREATE OR REPLACE FUNCTION "audit"."on_workflow_command_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "audit"."record_event"(
      NEW.tenant_id,
      NEW.home_id,
      'workflow.command_recorded',
      'workflow_command',
      NEW.id,
      jsonb_build_object(
        'workflow_instance_id', NEW.workflow_instance_id,
        'command_type', NEW.command_type,
        'status', NEW.status
      )
    );
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM "audit"."record_event"(
      NEW.tenant_id,
      NEW.home_id,
      'workflow.command_status_changed',
      'workflow_command',
      NEW.id,
      jsonb_build_object(
        'workflow_instance_id', NEW.workflow_instance_id,
        'command_type', NEW.command_type,
        'status', jsonb_build_object('before', OLD.status, 'after', NEW.status)
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "workflow_commands_audit_ins"
AFTER INSERT ON "core"."workflow_commands"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_workflow_command_change"();
CREATE TRIGGER "workflow_commands_audit_upd"
AFTER UPDATE ON "core"."workflow_commands"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_workflow_command_change"();

GRANT SELECT, INSERT, UPDATE ON TABLE "core"."workflow_instances" TO "careos_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "core"."workflow_commands" TO "careos_app";