-- Phase 3 §1 — Mattermost foundation: channel mappings, one-time /link codes,
-- and linked Keycloak <-> Mattermost identities. All tables are tenant/home
-- scoped under RLS; audit triggers emit append-only events to audit.events.
--
-- The provider integration itself is stubbed in NestJS (MattermostProvider);
-- credentials live outside the repo and only the `disabled` stub provider
-- runs by default.

CREATE TYPE "core"."ChannelKind" AS ENUM ('home', 'safeguarding', 'rota', 'general');

CREATE TABLE "core"."channel_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "kind" "core"."ChannelKind" NOT NULL,
    "channel_id" TEXT NOT NULL,
    "channel_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_mappings_tenant_home_kind_key"
    ON "core"."channel_mappings"("tenant_id", "home_id", "kind");
CREATE UNIQUE INDEX "channel_mappings_tenant_channel_key"
    ON "core"."channel_mappings"("tenant_id", "channel_id");

ALTER TABLE "core"."channel_mappings"
    ADD CONSTRAINT "channel_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."channel_mappings"
    ADD CONSTRAINT "channel_mappings_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "core"."channel_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."channel_mappings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_mappings_tenant_home_isolation" ON "core"."channel_mappings"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION "audit"."on_channel_mappings_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'mattermost.channel.mapped',
            'channel_mapping',
            NEW.id,
            jsonb_build_object(
                'kind', NEW.kind,
                'channel_id', NEW.channel_id,
                'channel_name', NEW.channel_name
            )
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'mattermost.channel.updated',
            'channel_mapping',
            NEW.id,
            jsonb_build_object(
                'kind', NEW.kind,
                'channel_id', jsonb_build_object('before', OLD.channel_id, 'after', NEW.channel_id),
                'channel_name', jsonb_build_object('before', OLD.channel_name, 'after', NEW.channel_name)
            )
        );
        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "channel_mappings_audit_ins"
AFTER INSERT ON "core"."channel_mappings"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_channel_mappings_change"();
CREATE TRIGGER "channel_mappings_audit_upd"
AFTER UPDATE ON "core"."channel_mappings"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_channel_mappings_change"();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."channel_mappings" TO "careos_app";


-- One-time link codes issued to a logged-in CareOS user; the user pastes the
-- code into Mattermost via `/link` and the bot calls `/comms/mattermost/link-codes/exchange`.
CREATE TABLE "core"."link_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "home_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "mattermost_user_id" TEXT,
    "mattermost_username" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "link_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "link_codes_code_key" ON "core"."link_codes"("code");
CREATE INDEX "link_codes_tenant_home_user_idx"
    ON "core"."link_codes"("tenant_id", "home_id", "user_id");
CREATE INDEX "link_codes_expires_at_idx" ON "core"."link_codes"("expires_at");

ALTER TABLE "core"."link_codes"
    ADD CONSTRAINT "link_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."link_codes"
    ADD CONSTRAINT "link_codes_home_id_fkey" FOREIGN KEY ("home_id") REFERENCES "core"."homes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."link_codes"
    ADD CONSTRAINT "link_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "core"."link_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."link_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "link_codes_tenant_home_isolation" ON "core"."link_codes"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
        AND "home_id" = NULLIF(current_setting('app.current_home_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION "audit"."on_link_codes_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'mattermost.link_code.issued',
            'link_code',
            NEW.id,
            jsonb_build_object(
                'user_id', NEW.user_id,
                'expires_at', NEW.expires_at
            )
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.used_at IS NULL AND NEW.used_at IS NOT NULL THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'mattermost.link_code.exchanged',
            'link_code',
            NEW.id,
            jsonb_build_object(
                'user_id', NEW.user_id,
                'mattermost_user_id', NEW.mattermost_user_id,
                'mattermost_username', NEW.mattermost_username
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "link_codes_audit_ins"
AFTER INSERT ON "core"."link_codes"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_link_codes_change"();
CREATE TRIGGER "link_codes_audit_upd"
AFTER UPDATE ON "core"."link_codes"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_link_codes_change"();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."link_codes" TO "careos_app";


-- Final binding between a CareOS user and a Mattermost user. tenant_id is on
-- the row for RLS; home_id is intentionally absent because a user may belong
-- to multiple homes — we scope to tenant only and rely on the user FK plus the
-- exchange path (which is home-scoped) to keep audit useful.
CREATE TABLE "core"."linked_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mattermost_user_id" TEXT NOT NULL,
    "mattermost_username" TEXT NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "linked_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "linked_identities_tenant_user_key"
    ON "core"."linked_identities"("tenant_id", "user_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "linked_identities_tenant_mm_key"
    ON "core"."linked_identities"("tenant_id", "mattermost_user_id") WHERE "revoked_at" IS NULL;

ALTER TABLE "core"."linked_identities"
    ADD CONSTRAINT "linked_identities_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "core"."linked_identities"
    ADD CONSTRAINT "linked_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "core"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "core"."linked_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "core"."linked_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "linked_identities_tenant_isolation" ON "core"."linked_identities"
    FOR ALL
    USING (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    );

CREATE OR REPLACE FUNCTION "audit"."on_linked_identities_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_home uuid;
BEGIN
    v_home := NULLIF(current_setting('app.current_home_id', true), '')::uuid;

    IF TG_OP = 'INSERT' THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            v_home,
            'mattermost.identity.linked',
            'linked_identity',
            NEW.id,
            jsonb_build_object(
                'user_id', NEW.user_id,
                'mattermost_user_id', NEW.mattermost_user_id,
                'mattermost_username', NEW.mattermost_username
            )
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            v_home,
            'mattermost.identity.revoked',
            'linked_identity',
            NEW.id,
            jsonb_build_object(
                'user_id', NEW.user_id,
                'mattermost_user_id', NEW.mattermost_user_id
            )
        );
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "linked_identities_audit_ins"
AFTER INSERT ON "core"."linked_identities"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_linked_identities_change"();
CREATE TRIGGER "linked_identities_audit_upd"
AFTER UPDATE ON "core"."linked_identities"
FOR EACH ROW EXECUTE FUNCTION "audit"."on_linked_identities_change"();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "core"."linked_identities" TO "careos_app";
