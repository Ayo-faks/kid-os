CREATE TABLE "core"."system_workflow_instances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workflow_kind" TEXT NOT NULL,
  "runtime" "core"."WorkflowRuntimeKind" NOT NULL,
  "instance_id" TEXT NOT NULL,
  "orchestration_name" TEXT NOT NULL,
  "orchestration_version" TEXT,
  "status" TEXT NOT NULL DEFAULT 'running',
  "correlation_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "system_workflow_instances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "system_workflow_instances_id_format_check" CHECK (
    length("instance_id") BETWEEN 1 AND 100
    AND "instance_id" !~ '^@'
    AND "instance_id" ~ '^[ -~]+$'
  ),
  CONSTRAINT "system_workflow_instances_status_check" CHECK (
    "status" IN ('pending', 'running', 'completed', 'failed', 'terminated')
  )
);

CREATE UNIQUE INDEX "system_workflow_instances_instance_id_key"
  ON "core"."system_workflow_instances" ("instance_id");

CREATE TABLE "core"."system_workflow_commands" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workflow_instance_id" UUID NOT NULL,
  "command_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "result" JSONB,
  "status" "core"."WorkflowCommandStatus" NOT NULL DEFAULT 'pending',
  "failure_reason" TEXT,
  "processed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "system_workflow_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "system_workflow_commands_payload_object_check"
    CHECK (jsonb_typeof("payload") = 'object'),
  CONSTRAINT "system_workflow_commands_result_object_check"
    CHECK ("result" IS NULL OR jsonb_typeof("result") = 'object'),
  CONSTRAINT "system_workflow_commands_instance_fkey"
    FOREIGN KEY ("workflow_instance_id")
    REFERENCES "core"."system_workflow_instances"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "system_workflow_commands_dedupe_key"
  ON "core"."system_workflow_commands" ("workflow_instance_id", "command_type", "payload_hash");

ALTER TABLE "core"."system_workflow_instances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."system_workflow_instances" FORCE ROW LEVEL SECURITY;
CREATE POLICY "system_workflow_instances_system_only"
  ON "core"."system_workflow_instances"
  FOR ALL
  USING (current_setting('app.current_actor_kind', true) = 'system')
  WITH CHECK (current_setting('app.current_actor_kind', true) = 'system');

ALTER TABLE "core"."system_workflow_commands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."system_workflow_commands" FORCE ROW LEVEL SECURITY;
CREATE POLICY "system_workflow_commands_system_only"
  ON "core"."system_workflow_commands"
  FOR ALL
  USING (current_setting('app.current_actor_kind', true) = 'system')
  WITH CHECK (current_setting('app.current_actor_kind', true) = 'system');

GRANT SELECT, INSERT, UPDATE ON TABLE "core"."system_workflow_instances" TO "careos_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "core"."system_workflow_commands" TO "careos_app";