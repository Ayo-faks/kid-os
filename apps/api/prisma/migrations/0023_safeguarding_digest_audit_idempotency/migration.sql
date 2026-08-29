CREATE UNIQUE INDEX "events_safeguarding_digest_dispatch_key"
  ON "audit"."events" (
    "tenant_id",
    "home_id",
    ("metadata" ->> 'dispatch_key')
  )
  WHERE "action" = 'safeguarding.weekly_digest_dispatched'
    AND "metadata" ? 'dispatch_key';