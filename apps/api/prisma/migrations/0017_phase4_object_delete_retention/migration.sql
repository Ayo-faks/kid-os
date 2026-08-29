-- Phase 4 retention correction: attachment retention performs verified object
-- deletion. Rename the earlier marker-only crypto_shred terminology without
-- rewriting shipped migration history.

ALTER TYPE "core"."RetentionAction"
    RENAME VALUE 'crypto_shred' TO 'object_delete';

ALTER TABLE "core"."attachments"
    RENAME COLUMN "crypto_shredded_at" TO "object_deleted_at";

ALTER INDEX "core"."attachments_crypto_shredded_idx"
    RENAME TO "attachments_object_deleted_idx";

CREATE OR REPLACE FUNCTION "audit"."on_attachment_retention_applied"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.object_deleted_at IS NOT NULL
       AND (OLD.object_deleted_at IS NULL OR OLD.object_deleted_at IS DISTINCT FROM NEW.object_deleted_at) THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'retention.applied',
            'attachment',
            NEW.id,
            jsonb_build_object(
                'action', 'object_delete',
                'retention_policy_id', NEW.retention_policy_id,
                'object_deleted_at', NEW.object_deleted_at,
                'object_key', NEW.object_key
            )
        );
    ELSIF NEW.soft_deleted_at IS NOT NULL
       AND (OLD.soft_deleted_at IS NULL OR OLD.soft_deleted_at IS DISTINCT FROM NEW.soft_deleted_at) THEN
        PERFORM "audit"."record_event"(
            NEW.tenant_id,
            NEW.home_id,
            'retention.applied',
            'attachment',
            NEW.id,
            jsonb_build_object(
                'action', 'soft_delete',
                'retention_policy_id', NEW.retention_policy_id,
                'soft_deleted_at', NEW.soft_deleted_at
            )
        );
    END IF;
    RETURN NEW;
END;
$$;
