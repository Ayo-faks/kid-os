CREATE TYPE "core"."IncidentFollowUpKind" AS ENUM ('safeguarding_email', 'export_bundle');
CREATE TYPE "core"."IncidentFollowUpStatus" AS ENUM (
  'queued', 'running', 'needs_configuration', 'awaiting_approval',
  'completed', 'rejected', 'failed'
);

CREATE TABLE "core"."incident_follow_up_actions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "home_id" UUID NOT NULL,
  "incident_id" UUID NOT NULL,
  "kind" "core"."IncidentFollowUpKind" NOT NULL,
  "status" "core"."IncidentFollowUpStatus" NOT NULL DEFAULT 'queued',
  "target_id" UUID NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1 CHECK ("attempt" > 0),
  "requested_by_user_id" UUID NOT NULL,
  "failure_code" TEXT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "incident_follow_up_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "incident_follow_up_actions_incident_fkey"
    FOREIGN KEY ("incident_id") REFERENCES "core"."incidents"("id") ON DELETE RESTRICT,
  CONSTRAINT "incident_follow_up_actions_requested_by_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "incident_follow_up_actions_semantic_key"
  ON "core"."incident_follow_up_actions" ("tenant_id", "home_id", "incident_id", "kind");
CREATE UNIQUE INDEX "incident_follow_up_actions_workflow_id_key"
  ON "core"."incident_follow_up_actions" ("workflow_id");
CREATE INDEX "incident_follow_up_actions_incident_idx"
  ON "core"."incident_follow_up_actions" ("incident_id", "created_at");

ALTER TABLE "core"."incident_follow_up_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."incident_follow_up_actions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "incident_follow_up_actions_tenant_home_isolation"
  ON "core"."incident_follow_up_actions"
  FOR ALL
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION "audit"."on_incident_follow_up_action_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
  v_diff jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'incident_follow_up.queued';
    v_diff := jsonb_build_object(
      'incident_id', NEW.incident_id,
      'kind', NEW.kind,
      'status', NEW.status,
      'attempt', NEW.attempt
    );
  ELSIF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.attempt IS DISTINCT FROM OLD.attempt THEN
    v_action := 'incident_follow_up.status_changed';
    v_diff := jsonb_build_object(
      'kind', NEW.kind,
      'status', jsonb_build_object('before', OLD.status, 'after', NEW.status),
      'attempt', NEW.attempt,
      'failure_code', NEW.failure_code
    );
  ELSE
    RETURN NEW;
  END IF;

  PERFORM "audit"."record_event"(
    NEW.tenant_id, NEW.home_id, v_action, 'incident_follow_up', NEW.id, v_diff
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "incident_follow_up_actions_audit_ins"
AFTER INSERT ON "core"."incident_follow_up_actions"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_incident_follow_up_action_change"();
CREATE TRIGGER "incident_follow_up_actions_audit_upd"
AFTER UPDATE ON "core"."incident_follow_up_actions"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_incident_follow_up_action_change"();

GRANT SELECT, INSERT, UPDATE ON TABLE "core"."incident_follow_up_actions" TO "careos_app";