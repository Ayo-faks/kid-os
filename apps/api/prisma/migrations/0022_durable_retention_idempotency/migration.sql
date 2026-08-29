ALTER TABLE "core"."retention_runs"
  ADD COLUMN "execution_key" TEXT;

CREATE UNIQUE INDEX "retention_runs_execution_key_key"
  ON "core"."retention_runs" ("execution_key")
  WHERE "execution_key" IS NOT NULL;