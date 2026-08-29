CREATE TABLE "core"."rota_analysis_results" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "home_id" UUID NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "result" JSONB,
  "failure_code" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "rota_analysis_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rota_analysis_results_status_check"
    CHECK ("status" IN ('processing', 'completed', 'failed')),
  CONSTRAINT "rota_analysis_results_terminal_shape_check"
    CHECK (
      ("status" = 'processing' AND "result" IS NULL AND "failure_code" IS NULL)
      OR ("status" = 'completed' AND jsonb_typeof("result") = 'object' AND "failure_code" IS NULL)
      OR ("status" = 'failed' AND "result" IS NULL AND "failure_code" IS NOT NULL)
    ),
  CONSTRAINT "rota_analysis_results_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT,
  CONSTRAINT "rota_analysis_results_home_fkey"
    FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "rota_analysis_results_workflow_id_key"
  ON "core"."rota_analysis_results" ("workflow_id");
CREATE INDEX "rota_analysis_results_tenant_home_created_idx"
  ON "core"."rota_analysis_results" ("tenant_id", "home_id", "created_at" DESC);

ALTER TABLE "core"."rota_analysis_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."rota_analysis_results" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rota_analysis_results_tenant_home_isolation"
  ON "core"."rota_analysis_results"
  FOR ALL
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION "audit"."on_rota_analysis_result_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_action text;
  v_gap_count integer;
  v_proposal_count integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := CASE NEW.status
      WHEN 'completed' THEN 'rota_analysis.completed'
      WHEN 'failed' THEN 'rota_analysis.failed'
      ELSE 'rota_analysis.started'
    END;
  ELSIF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  ELSE
    v_action := CASE NEW.status
      WHEN 'completed' THEN 'rota_analysis.completed'
      WHEN 'failed' THEN 'rota_analysis.failed'
      ELSE 'rota_analysis.status_changed'
    END;
  END IF;

  v_gap_count := CASE
    WHEN jsonb_typeof(NEW.result -> 'gaps') = 'array'
      THEN jsonb_array_length(NEW.result -> 'gaps')
    ELSE 0
  END;
  v_proposal_count := CASE
    WHEN jsonb_typeof(NEW.result -> 'proposals') = 'array'
      THEN jsonb_array_length(NEW.result -> 'proposals')
    ELSE 0
  END;

  PERFORM "audit"."record_event"(
    NEW.tenant_id,
    NEW.home_id,
    v_action,
    'rota_analysis',
    NEW.id,
    jsonb_build_object(
      'status', NEW.status,
      'gap_count', v_gap_count,
      'proposal_count', v_proposal_count,
      'failure_code', NEW.failure_code
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "rota_analysis_results_audit_ins"
AFTER INSERT ON "core"."rota_analysis_results"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_rota_analysis_result_change"();
CREATE TRIGGER "rota_analysis_results_audit_upd"
AFTER UPDATE ON "core"."rota_analysis_results"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_rota_analysis_result_change"();

GRANT SELECT, INSERT, UPDATE ON TABLE "core"."rota_analysis_results" TO "careos_app";
