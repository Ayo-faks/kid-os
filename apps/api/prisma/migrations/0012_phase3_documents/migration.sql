-- Phase 3 §5 (D5) — Document ingestion foundation.
--
-- Adds `core.documents` for uploaded files awaiting OCR/extraction. Real
-- Docling/OCR extraction is a Phase 4 follow-up; this slice records
-- registrations and lets a stub `DocIngestWorkflow` flip status from
-- uploaded → extracting → extracted with audit attribution.

CREATE TYPE "core"."DocumentStatus" AS ENUM (
    'uploaded',
    'extracting',
    'extracted',
    'failed'
);

CREATE TABLE "core"."documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "uploader_user_id" UUID NOT NULL,
    "workflow_id" TEXT,
    "object_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" "core"."DocumentStatus" NOT NULL DEFAULT 'uploaded',
    "extracted_text" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "core"."documents"
    ADD CONSTRAINT "documents_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT;

ALTER TABLE "core"."documents"
    ADD CONSTRAINT "documents_home_id_fkey"
    FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT;

ALTER TABLE "core"."documents"
    ADD CONSTRAINT "documents_uploader_user_id_fkey"
    FOREIGN KEY ("uploader_user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "documents_workflow_id_key" ON "core"."documents"("workflow_id");
CREATE INDEX "documents_tenant_home_status_idx" ON "core"."documents"("tenant_id", "home_id", "status");
CREATE INDEX "documents_tenant_home_created_idx" ON "core"."documents"("tenant_id", "home_id", "created_at");

ALTER TABLE "core"."documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."documents" FORCE ROW LEVEL SECURITY;

CREATE POLICY "documents_tenant_home_isolation" ON "core"."documents"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

-- Audit triggers — emit `document.registered` on INSERT and
-- `document.status_changed` on UPDATE of `status`. Uses the existing
-- `audit.record_event` helper which reads actor GUCs from the session.

CREATE OR REPLACE FUNCTION "audit"."on_documents_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "audit"."record_event"(
        NEW.tenant_id,
        NEW.home_id,
        'document.registered',
        'document',
        NEW.id,
        jsonb_build_object(
            'status', NEW.status,
            'mime_type', NEW.mime_type,
            'original_filename', NEW.original_filename,
            'object_key', NEW.object_key,
            'size_bytes', NEW.size_bytes
        )
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER "documents_audit_ins"
AFTER INSERT ON "core"."documents"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_documents_insert"();

CREATE OR REPLACE FUNCTION "audit"."on_documents_status_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'document.status_changed',
            'document',
            NEW.id,
            jsonb_build_object(
                'from', OLD.status,
                'to', NEW.status,
                'failure_reason', NEW.failure_reason
            )
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "documents_audit_upd"
AFTER UPDATE OF "status" ON "core"."documents"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_documents_status_change"();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."documents" TO "careos_app";
