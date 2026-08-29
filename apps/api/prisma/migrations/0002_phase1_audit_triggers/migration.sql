-- Phase 1 §1 — audit triggers for incidents/incident_versions/timeline_entries,
-- plus timeline_entries immutability.
--
-- Reads the per-request session GUCs set by NestJS's PrismaService:
--   app.current_tenant_id      (already set by Phase 0)
--   app.current_home_id        (already set by Phase 0)
--   app.current_actor_kind     ('user' | 'agent' | 'system'; defaults to 'system')
--   app.current_actor_user_id  (UUID of core.users row; nullable)
--   app.current_correlation_id (request correlation id; nullable)
--   app.current_agent_run_id   (Hermes run id when actor_kind = 'agent')
--   app.current_prompt_hash    (sha256 of redacted prompt when actor_kind = 'agent')

CREATE OR REPLACE FUNCTION "audit"."current_setting_or_null"(setting_name text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    raw text;
BEGIN
    raw := current_setting(setting_name, true);
    IF raw IS NULL OR raw = '' THEN
        RETURN NULL;
    END IF;
    RETURN raw;
END;
$$;

CREATE OR REPLACE FUNCTION "audit"."record_event"(
    p_tenant_id   uuid,
    p_home_id     uuid,
    p_action      text,
    p_subject_type text,
    p_subject_id  uuid,
    p_diff        jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_actor_kind   text;
    v_actor_user   uuid;
    v_correlation  text;
    v_agent_run    text;
    v_prompt_hash  text;
BEGIN
    v_actor_kind  := COALESCE("audit"."current_setting_or_null"('app.current_actor_kind'), 'system');
    v_actor_user  := NULLIF("audit"."current_setting_or_null"('app.current_actor_user_id'), '')::uuid;
    v_correlation := "audit"."current_setting_or_null"('app.current_correlation_id');
    v_agent_run   := "audit"."current_setting_or_null"('app.current_agent_run_id');
    v_prompt_hash := "audit"."current_setting_or_null"('app.current_prompt_hash');

    INSERT INTO "audit"."events" (
        tenant_id,
        home_id,
        actor_kind,
        actor_user_id,
        agent_run_id,
        prompt_hash,
        correlation_id,
        action,
        subject_type,
        subject_id,
        diff
    )
    VALUES (
        p_tenant_id,
        p_home_id,
        v_actor_kind,
        v_actor_user,
        v_agent_run,
        v_prompt_hash,
        v_correlation,
        p_action,
        p_subject_type,
        p_subject_id,
        p_diff
    );
END;
$$;

-- ─── incidents ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "audit"."on_incidents_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_action text;
    v_diff   jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_action := 'incident.created';
        v_diff   := jsonb_build_object(
            'status',      NEW.status,
            'resident_id', NEW.resident_id,
            'form_template_id', NEW.form_template_id,
            'author_user_id', NEW.author_user_id
        );
        PERFORM "audit"."record_event"(NEW.tenant_id, NEW.home_id, v_action, 'incident', NEW.id, v_diff);
        RETURN NEW;
    END IF;

    -- UPDATE: only emit when a meaningful field changes; skip pure updated_at touches.
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_action := CASE NEW.status::text
            WHEN 'awaiting_approval' THEN 'incident.submitted'
            WHEN 'approved'          THEN 'incident.approved'
            WHEN 'exported'          THEN 'incident.exported'
            WHEN 'rejected'          THEN 'incident.rejected'
            ELSE                          'incident.status_changed'
        END;
        v_diff := jsonb_build_object(
            'status', jsonb_build_object('before', OLD.status, 'after', NEW.status)
        );
        PERFORM "audit"."record_event"(NEW.tenant_id, NEW.home_id, v_action, 'incident', NEW.id, v_diff);
    ELSIF NEW.current_version IS DISTINCT FROM OLD.current_version THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id, NEW.home_id, 'incident.version_advanced', 'incident', NEW.id,
            jsonb_build_object(
                'current_version', jsonb_build_object('before', OLD.current_version, 'after', NEW.current_version)
            )
        );
    ELSIF NEW.export_object_key IS DISTINCT FROM OLD.export_object_key
       OR NEW.exported_at IS DISTINCT FROM OLD.exported_at THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id, NEW.home_id, 'incident.export_recorded', 'incident', NEW.id,
            jsonb_build_object('export_object_key', NEW.export_object_key)
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "incidents_audit_ins"
AFTER INSERT ON "core"."incidents"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_incidents_change"();

CREATE TRIGGER "incidents_audit_upd"
AFTER UPDATE ON "core"."incidents"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_incidents_change"();

-- ─── incident_versions (insert-only by design) ────────────────────────────────

CREATE OR REPLACE FUNCTION "audit"."on_incident_versions_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "audit"."record_event"(
        NEW.tenant_id,
        NEW.home_id,
        'incident_version.created',
        'incident_version',
        NEW.id,
        jsonb_build_object(
            'incident_id',       NEW.incident_id,
            'version',           NEW.version,
            'status',            NEW.status,
            'actor_kind',        NEW.actor_kind,
            'missing_mandatory', to_jsonb(NEW.missing_mandatory)
        )
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER "incident_versions_audit_ins"
AFTER INSERT ON "core"."incident_versions"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_incident_versions_change"();

-- ─── timeline_entries: audit on insert + immutable on update/delete ─────────

CREATE OR REPLACE FUNCTION "audit"."on_timeline_entries_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM "audit"."record_event"(
        NEW.tenant_id,
        NEW.home_id,
        'timeline.created',
        'timeline_entry',
        NEW.id,
        jsonb_build_object(
            'kind',        NEW.kind,
            'resident_id', NEW.resident_id,
            'incident_id', NEW.incident_id,
            'task_id',     NEW.task_id,
            'occurred_at', NEW.occurred_at
        )
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER "timeline_entries_audit_ins"
AFTER INSERT ON "core"."timeline_entries"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_timeline_entries_change"();

CREATE OR REPLACE FUNCTION "core"."raise_on_timeline_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'core.timeline_entries is append-only; % is not allowed', TG_OP
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "timeline_entries_immutable"
BEFORE UPDATE OR DELETE ON "core"."timeline_entries"
FOR EACH ROW EXECUTE FUNCTION "core"."raise_on_timeline_mutation"();

-- Allow the application role to call the helper (triggers run as table owner so
-- this is technically not required, but we expose it for service-layer use
-- e.g. workflow activities recording explicit audit events).
GRANT EXECUTE ON FUNCTION "audit"."record_event"(uuid, uuid, text, text, uuid, jsonb) TO "careos_app";
GRANT EXECUTE ON FUNCTION "audit"."current_setting_or_null"(text) TO "careos_app";
