-- Phase 0 #4 bootstrap migration.
-- Baseline DDL generated with:
-- pnpm dlx prisma@5.22.0 migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script

CREATE SCHEMA IF NOT EXISTS "audit";
CREATE SCHEMA IF NOT EXISTS "core";
CREATE SCHEMA IF NOT EXISTS "vector";

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careos_app') THEN
        CREATE ROLE "careos_app" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
    END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TYPE "core"."IncidentStatus" AS ENUM ('draft', 'awaiting_fields', 'awaiting_approval', 'approved', 'exported', 'rejected');
CREATE TYPE "core"."TimelineKind" AS ENUM ('incident', 'note', 'task', 'comm', 'system');
CREATE TYPE "core"."TaskStatus" AS ENUM ('open', 'in_progress', 'done', 'cancelled');

CREATE TABLE "core"."tenants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."homes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ofsted_urn" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "homes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "keycloak_sub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "home_ids" UUID[],
    "roles" TEXT[],
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."residents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "preferred_name" TEXT,
    "date_of_birth" DATE NOT NULL,
    "nhs_number" TEXT,
    "arrived_at" TIMESTAMP(3) NOT NULL,
    "left_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "residents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."form_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "template_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "schema" JSONB NOT NULL,
    "ui_schema" JSONB NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMP(3),

    CONSTRAINT "form_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "form_template_id" UUID NOT NULL,
    "workflow_id" TEXT,
    "status" "core"."IncidentStatus" NOT NULL DEFAULT 'draft',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "author_user_id" UUID NOT NULL,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMP(3),
    "exported_at" TIMESTAMP(3),
    "export_object_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."incident_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "core"."IncidentStatus" NOT NULL,
    "form_data" JSONB NOT NULL,
    "missing_mandatory" TEXT[],
    "validation_errors" JSONB,
    "actor_kind" TEXT NOT NULL,
    "actor_user_id" UUID,
    "agent_run_id" TEXT,
    "prompt_hash" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."timeline_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "resident_id" UUID NOT NULL,
    "kind" "core"."TimelineKind" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB,
    "incident_id" UUID,
    "task_id" UUID,
    "actor_kind" TEXT NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timeline_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "incident_id" UUID,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "resident_id" UUID,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "status" "core"."TaskStatus" NOT NULL DEFAULT 'open',
    "due_at" TIMESTAMP(3),
    "assigned_user_id" UUID,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "workflow_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "core"."outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit"."events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_kind" TEXT NOT NULL,
    "actor_user_id" UUID,
    "agent_run_id" TEXT,
    "prompt_hash" TEXT,
    "correlation_id" TEXT,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "diff" JSONB,
    "metadata" JSONB,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "homes_tenant_id_idx" ON "core"."homes"("tenant_id");
CREATE UNIQUE INDEX "homes_tenant_id_name_key" ON "core"."homes"("tenant_id", "name");
CREATE UNIQUE INDEX "users_keycloak_sub_key" ON "core"."users"("keycloak_sub");
CREATE INDEX "users_tenant_id_idx" ON "core"."users"("tenant_id");
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "core"."users"("tenant_id", "email");
CREATE INDEX "residents_tenant_id_home_id_idx" ON "core"."residents"("tenant_id", "home_id");
CREATE INDEX "form_templates_tenant_id_template_id_idx" ON "core"."form_templates"("tenant_id", "template_id");
CREATE UNIQUE INDEX "form_templates_tenant_id_template_id_version_key" ON "core"."form_templates"("tenant_id", "template_id", "version");
CREATE UNIQUE INDEX "incidents_workflow_id_key" ON "core"."incidents"("workflow_id");
CREATE INDEX "incidents_tenant_id_home_id_idx" ON "core"."incidents"("tenant_id", "home_id");
CREATE INDEX "incidents_resident_id_idx" ON "core"."incidents"("resident_id");
CREATE INDEX "incidents_status_idx" ON "core"."incidents"("status");
CREATE INDEX "incident_versions_tenant_id_home_id_idx" ON "core"."incident_versions"("tenant_id", "home_id");
CREATE UNIQUE INDEX "incident_versions_incident_id_version_key" ON "core"."incident_versions"("incident_id", "version");
CREATE INDEX "timeline_entries_tenant_id_home_id_resident_id_occurred_at_idx" ON "core"."timeline_entries"("tenant_id", "home_id", "resident_id", "occurred_at");
CREATE INDEX "timeline_entries_resident_id_occurred_at_idx" ON "core"."timeline_entries"("resident_id", "occurred_at");
CREATE INDEX "attachments_tenant_id_home_id_idx" ON "core"."attachments"("tenant_id", "home_id");
CREATE INDEX "tasks_tenant_id_home_id_status_idx" ON "core"."tasks"("tenant_id", "home_id", "status");
CREATE INDEX "idempotency_keys_expires_at_idx" ON "core"."idempotency_keys"("expires_at");
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_key_key" ON "core"."idempotency_keys"("tenant_id", "key");
CREATE INDEX "outbox_status_available_at_idx" ON "core"."outbox"("status", "available_at");
CREATE INDEX "events_tenant_id_home_id_occurred_at_idx" ON "audit"."events"("tenant_id", "home_id", "occurred_at");
CREATE INDEX "events_subject_type_subject_id_idx" ON "audit"."events"("subject_type", "subject_id");
CREATE INDEX "events_correlation_id_idx" ON "audit"."events"("correlation_id");

ALTER TABLE "core"."homes" ADD CONSTRAINT "homes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."residents" ADD CONSTRAINT "residents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."residents" ADD CONSTRAINT "residents_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."form_templates" ADD CONSTRAINT "form_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."incidents" ADD CONSTRAINT "incidents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."incidents" ADD CONSTRAINT "incidents_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."incidents" ADD CONSTRAINT "incidents_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "core"."residents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."incidents" ADD CONSTRAINT "incidents_form_template_id_fkey" FOREIGN KEY ("form_template_id") REFERENCES "core"."form_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."incidents" ADD CONSTRAINT "incidents_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."incident_versions" ADD CONSTRAINT "incident_versions_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "core"."incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core"."incident_versions" ADD CONSTRAINT "incident_versions_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "core"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "core"."timeline_entries" ADD CONSTRAINT "timeline_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."timeline_entries" ADD CONSTRAINT "timeline_entries_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."timeline_entries" ADD CONSTRAINT "timeline_entries_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "core"."residents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."timeline_entries" ADD CONSTRAINT "timeline_entries_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "core"."incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "core"."timeline_entries" ADD CONSTRAINT "timeline_entries_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "core"."tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "core"."timeline_entries" ADD CONSTRAINT "timeline_entries_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "core"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "core"."attachments" ADD CONSTRAINT "attachments_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "core"."incidents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "core"."tasks" ADD CONSTRAINT "tasks_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."tasks" ADD CONSTRAINT "tasks_resident_id_fkey" FOREIGN KEY ("resident_id") REFERENCES "core"."residents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "core"."tasks" ADD CONSTRAINT "tasks_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "core"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "core"."tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenants_tenant_isolation" ON "core"."tenants"
    FOR ALL
    USING ("id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK ("id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "core"."homes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."homes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "homes_tenant_home_isolation" ON "core"."homes"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."users" FORCE ROW LEVEL SECURITY;
CREATE POLICY "users_tenant_isolation" ON "core"."users"
    FOR ALL
    USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "core"."residents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."residents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "residents_tenant_home_isolation" ON "core"."residents"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."form_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."form_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "form_templates_tenant_isolation" ON "core"."form_templates"
    FOR ALL
    USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "core"."incidents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."incidents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "incidents_tenant_home_isolation" ON "core"."incidents"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."incident_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."incident_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "incident_versions_tenant_home_isolation" ON "core"."incident_versions"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."timeline_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."timeline_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "timeline_entries_tenant_home_isolation" ON "core"."timeline_entries"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attachments_tenant_home_isolation" ON "core"."attachments"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tasks_tenant_home_isolation" ON "core"."tasks"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

ALTER TABLE "core"."idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "idempotency_keys_tenant_isolation" ON "core"."idempotency_keys"
    FOR ALL
    USING ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE "core"."outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_tenant_home_isolation" ON "core"."outbox"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND (
            "home_id" IS NULL
            OR "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
        )
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND (
            "home_id" IS NULL
            OR "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
        )
    );

ALTER TABLE "audit"."events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit"."events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "events_tenant_home_isolation" ON "audit"."events"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND (
            "home_id" IS NULL
            OR "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
        )
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND (
            "home_id" IS NULL
            OR "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
        )
    );

CREATE OR REPLACE FUNCTION "audit"."raise_on_events_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        RAISE EXCEPTION 'audit.events is append-only; % is not allowed', TG_OP
            USING ERRCODE = '55000';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "events_append_only"
BEFORE UPDATE OR DELETE ON "audit"."events"
FOR EACH ROW
EXECUTE FUNCTION "audit"."raise_on_events_mutation"();

GRANT USAGE ON SCHEMA "core", "audit", "vector" TO "careos_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "core" TO "careos_app";
GRANT SELECT, INSERT ON TABLE "audit"."events" TO "careos_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA "core" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "careos_app";
ALTER DEFAULT PRIVILEGES IN SCHEMA "audit" GRANT SELECT, INSERT ON TABLES TO "careos_app";

REVOKE UPDATE, DELETE ON TABLE "audit"."events" FROM PUBLIC;