# apps/api/prisma

Prisma data model and SQL migrations for the CareOS domain.

- `schema.prisma` — Prisma data model (source of truth for the Prisma client).
- `migrations/0001_init/` — Phase 0 #4 bootstrap: schemas, extensions, table
  DDL, RLS policies, append-only `audit.events` (trigger + REVOKE), and the
  `careos_app` role with least-privilege grants.
- `migrations/0002_phase1_audit_triggers/` — Phase 1 §1: `audit.record_event`
  function + AFTER INSERT/UPDATE triggers on `incidents`, `incident_versions`,
  and `timeline_entries` that write into `audit.events`. Also makes
  `core.timeline_entries` immutable (BEFORE UPDATE OR DELETE rejecter).

The application code sets per-request session GUCs so RLS policies and audit
triggers can attribute correctly. See `apps/api/src/prisma/prisma.service.ts`
(`setTenantContext`) and `apps/api/src/tenant/tenant.guard.ts`.
