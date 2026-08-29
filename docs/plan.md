# Plan: Residential Child Care OS — MVP, Self-Hosted, Hermes-Driven

> **Amendment 2026-07 (locked).** The LLM plane is now **provider-neutral
> with a local OSS default**. A real `llm-gateway` service (strict
> TypeScript/Fastify) owns task routing, provider translation, service
> authentication, PII redaction/rehydration, per-tenant budgets, and OTel.
> Local inference (Ollama, Apache-2.0 model via `CAREOS_LLM_MODEL`) is the
> default; Azure OpenAI / Foundry are **optional adapters** behind the same
> gateway and are never required for local development, PR CI, or tests.
> Retention's `crypto_shred` action is renamed to `object_delete` (verified
> MinIO object deletion with audit evidence); true envelope-key
> crypto-shredding is deferred until encrypted attachment upload exists.
> Additional locked decisions: safeguarding routing is deterministic
> (template/field driven; AI advisory only); safeguarding incidents and
> sensitive emails require two distinct humans covering manager and
> safeguarding-lead roles (one veto rejects); generated `dist`/`.next`
> output is never an implementation source; completion claims in
> `AGENTS.md` require passing release evidence from the same commit.
> Azure-specific wording below is retained for history but is superseded
> by this amendment.

## TL;DR

Build a multi-home residential child care operations platform as a NestJS-backed Next.js app deployed by Docker Compose on a private VPS (AKS-ready later). NestJS owns the domain (residents, incidents, handovers, rota, tasks, timeline, audit) with Postgres + Redis + pgvector + MinIO. Hermes Agent (Nous) runs as a separate service for conversational drafting, scheduled automations, and optional staff messaging channels — it never owns domain state; it calls NestJS over an MCP/OpenAPI tool surface that enforces RBAC, tenant scoping, validation, and audit. Temporal runs deterministic, resumable workflows (incident → review → approve → export, handover, rota change, notification). Keycloak provides SSO + tenant/home claims; Postgres RLS scopes data per home. Docling + Tesseract + Gotenberg handle document intake and PDF export. OTel → Grafana/Loki/Tempo/Prometheus + Sentry for observability. Novu for in-app/email notifications. Mattermost for staff comms (and as a Hermes gateway channel).

Everything in the app stack is open source and self-hostable. The **LLM plane is provider-neutral with a local OSS default** (superseding the earlier Azure-first wording — see the amendment above). Hermes Agent points at the internal `llm-gateway`, which routes to a local Ollama/OpenAI-compatible upstream by default and to Azure OpenAI / Foundry only when explicitly configured. The agent runtime, domain, workflows, identity, storage, and observability remain fully on-prem in Compose; model inference is local by default and only egresses to Azure when the optional adapter is selected.

---

## Architecture at a glance

Four planes, deployed as separate containers:

1. **Edge / UI plane** — Next.js App Router (RSC), shadcn/ui, Tailwind, RHF + Zod, schema-driven form renderer. Talks only to the BFF.
2. **Domain plane (system of record)** — NestJS REST (OpenAPI-first) + Prisma + Postgres (RLS) + Redis + MinIO. Owns: auth context, validation, permissions, audit, idempotency, outbox. Exposes an internal MCP server (`/mcp`) that mirrors a curated subset of REST actions as agent tools.
3. **Workflow plane** — Temporal server + a TypeScript worker. Hosts long-running, retryable, human-in-the-loop flows: `IncidentReportWorkflow`, `HandoverWorkflow`, `RotaChangeWorkflow`, `ApprovalRoutingWorkflow`, `NotificationWorkflow`, `DocIngestWorkflow`. Activities call NestJS, Hermes, Gotenberg, Docling, Novu.
4. **Agent plane** — Hermes Agent (Python) running as a sidecar service. Configured to use the NestJS MCP server as its only tool surface for domain actions, plus its native skills/memory/cron/gateway. **LLM backend = Azure AI Foundry**: a primary Azure OpenAI deployment (e.g. `gpt-4.1` or `gpt-4o` for reasoning/drafting, `gpt-4o-mini` for cheap routing/summaries, `text-embedding-3-large` for pgvector) plus one or more Foundry model deployments (Llama-3.x / Mistral / Phi / Hermes-class when published) consumed via the Foundry **inference endpoint** (OpenAI-compatible). Hermes is invoked two ways: synchronously from Temporal activities (drafting, summarization, extraction) and asynchronously via its gateway (Mattermost + optional Telegram/Signal).

Cross-cutting:

- **Identity**: Keycloak realm `careos`, clients for web + api + mcp; claims include `tenant_id`, `home_ids[]`, `role`. NestJS validates JWT and pushes claims into Postgres session GUCs (`SET app.current_home_id`) so RLS policies bite.
- **Audit**: append-only `audit_events` table, written by a NestJS interceptor + Postgres triggers for hard guarantees. Hermes-originated actions are tagged with `actor_kind=agent`, `agent_run_id`, `prompt_hash`.
- **Idempotency**: every write endpoint requires `Idempotency-Key`; stored in Redis + Postgres unique index on `(tenant_id, key)`.
- **Outbox**: Temporal-driven outbox table flushes external sends (email via Novu, Mattermost posts, PDF exports to MinIO) so no side effect happens without a persisted event.
- **LLM gateway**: a single internal alias (`llm-gateway`) is the only path that may reach `*.openai.azure.com` / `*.inference.ai.azure.com`. It (a) authenticates via API key from Docker secret or Entra Workload Identity token, (b) tags every request with `tenant_id`, `home_id`, `workflow_id`, `correlation_id`, (c) enforces a per-tenant rate limit + monthly token budget in Redis, (d) runs a deterministic PII redactor (resident first/last name, DOB, NHS number, address) on outbound prompts and re-hydrates on responses, (e) emits an OTel span with token counts and cost. Egress firewall on the VPS allows only this container to reach Azure.
- **Model routing**: a small NestJS `LlmRouterService` maps logical task → Foundry deployment: `draft.high-stakes` → AOAI `gpt-4.1`, `summarize` → `gpt-4o-mini`, `extract-structured` → AOAI `gpt-4.1` with JSON-mode, `embed` → AOAI `text-embedding-3-large`, `chat.general` → Foundry Llama-3.x or Phi-4 deployment. Hermes calls the router (not Azure directly) for any non-conversational task; the conversational gateway path uses Hermes’s own provider config pinned to one deployment.

---

## Phase plan (mapped to PRD §14)

### Phase 0 — Foundation (workspace, infra, auth, CI)

Goal: empty but production-shaped skeleton with auth, RLS, audit, OTel, Temporal hello-world, Hermes hello-world, all in Compose.

1. Initialize monorepo (pnpm + turborepo): `apps/web` (Next.js), `apps/api` (NestJS), `apps/worker` (Temporal worker), `apps/agent` (Hermes config + skills), `packages/contracts` (Zod/OpenAPI), `packages/ui` (shadcn primitives), `packages/schemas` (JSON Schemas for forms), `infra/compose`.
2. Author `docker-compose.yml` with services: `postgres` (pgvector image), `redis`, `keycloak`, `minio`, `temporal` + `temporal-ui`, `hermes`, `gotenberg`, `tesseract-server` (or shipped in worker image), `docling-serve`, `novu`, `mattermost`, `otel-collector`, `grafana`, `loki`, `tempo`, `prometheus`, `caddy` (TLS reverse proxy). All on a single internal network; only `caddy`, `keycloak`, `mattermost` exposed. **No local GPU/vLLM container** — model calls egress to Azure AI Foundry over HTTPS through a single outbound proxy alias `llm-gateway` (Caddy or Envoy) that pins Foundry/AOAI hostnames, injects the API key / Entra token, and emits OTel spans for every call.
3. Keycloak realm import: `careos` realm, `web` + `api` + `mcp` clients, roles `support_worker`, `key_worker`, `shift_lead`, `manager`, `safeguarding_lead`, `ops_admin`, custom attributes `home_ids`, `tenant_id`. Group-based assignment per home.
4. Postgres bootstrap migration: schemas `core`, `audit`, `vector`; extensions `pgcrypto`, `pgvector`, `pg_trgm`; RLS enabled on every tenant table; `audit.events` append-only with `REVOKE UPDATE,DELETE`; session-GUC-based policy template.
5. NestJS skeleton: global Zod pipe, OpenAPI generator (`@nestjs/swagger`), Keycloak JWT guard, tenant/home guard that sets Postgres GUCs per request, audit interceptor, idempotency interceptor, Pino + OTel.
6. Next.js skeleton: App Router, NextAuth/Keycloak provider, shadcn init, layout matching the attached dashboard (sidebar nav, top search/notifications, card grid).
7. Temporal worker skeleton with one `PingWorkflow` proving NestJS → Temporal → Hermes round-trip.
8. Hermes service: container running `hermes gateway start` with config mounted from `apps/agent/`; **provider = Azure** (`hermes model` set to an Azure OpenAI deployment via the `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_DEPLOYMENT` env vars, or to the Foundry inference endpoint with `AZURE_AI_INFERENCE_ENDPOINT` + `AZURE_AI_INFERENCE_KEY`); configure MCP client pointing at `http://api:3000/mcp`; add an empty `careos` skill scaffold.
9. CI: GitHub Actions — lint, typecheck, unit tests, OpenAPI diff, Prisma migrate check, Compose smoke test, Trivy scan, SBOM.

### Phase 1 — Incident reporting + Resident timeline + Schema-driven UI

Goal: deliver the highest-value MVP acceptance criteria (PRD §12.2 items 1, 2, 5, 6, 7).

1. Domain model + Prisma schema: `tenants`, `homes`, `users` (mirror of Keycloak), `residents`, `incidents`, `incident_versions`, `timeline_entries`, `attachments`, `form_templates` (JSON Schema + UI Schema, versioned), `tasks`, `audit.events`, `idempotency_keys`, `outbox`.
2. JSON Schema renderer in `apps/web`: a `<SchemaForm>` component that consumes `{ schema, uiSchema, formData }` and renders shadcn fields via RHF + Zod (Zod generated from JSON Schema with `json-schema-to-zod`). Includes inline error rendering from server `ValidationError` shape.
3. Seed `form_templates` with v1 schemas: `incident.behavioural`, `incident.safeguarding`, `incident.medication-near-miss`, `handover.shift-end`, `note.observation`.
4. Incidents API: `POST /incidents` (draft from free text or partial fields), `PATCH /incidents/:id`, `POST /incidents/:id/submit`, `POST /incidents/:id/approve`, `GET /incidents/:id` with embedded timeline. All routed through `IncidentReportWorkflow` (Temporal) with states: `Draft → AwaitingFields → AwaitingApproval → Approved → Exported`.
5. Hermes activity `draftIncidentFromText`: takes `{templateId, freeText, residentId}`, returns `{formData, missingMandatory[], confidence}`. Validated against schema before persistence; never auto-submits.
6. Resident timeline view + API: append-only `timeline_entries` joined to incidents, notes, tasks; UI mirrors the “Today’s timeline” card pattern in the screenshot but scoped to a resident.
7. Care Assistant panel (right column in screenshot): chat surface that streams from a NestJS SSE endpoint backed by Hermes; quick-actions (“Create incident report”, “Notify safeguarding lead”, “Update behaviour log”) invoke Hermes with a fixed system prompt + slot template.
8. Audit + export: every state transition writes `audit.events`; `POST /incidents/:id/export` triggers `ExportPdfActivity` via Gotenberg → MinIO with signed URL.
9. E2E test: `create-incident-from-prompt.spec.ts` covers acceptance criterion (PRD §12.2 #1).

### Phase 2 — Handovers, Email drafting, Approvals, Rota assist

Goal: PRD §12.2 items 3, 4 + KPI #4 (manager approval turnaround).

1. `HandoverWorkflow`: ingest free-text or voice transcript (out-of-scope mic; supports upload), call Hermes `summarizeHandover` activity, persist `handover_records`, generate follow-up `tasks` attached to next shift’s assignees, dispatch via Novu.
2. Email drafting: `POST /comms/email/draft` → Hermes `draftEmail` activity → returns draft + sensitivity tag; if sensitive, route to `ApprovalRoutingWorkflow` requiring manager sign-off before SMTP send (via Novu provider). All sends go through outbox.
3. Approvals service: generic `approvals` table with polymorphic `subject_type, subject_id`; manager UI surfaces a queue (matches the “Approvals” nav item in screenshot).
4. Rota module: `shifts`, `shift_assignments`, `rota_rules` (min staffing, gender mix, qualification flags). `POST /rota/analyze` returns gaps + proposals via a deterministic solver in the worker (constraint solver: `minizinc` container or pure TS `cpsat`-style heuristic — start heuristic). Hermes only narrates the result; it never publishes. `POST /rota/publish` is a separate, RBAC-gated endpoint.
5. UI: “Today’s rota” card + full rota editor; gap badges as in screenshot (“2 gaps need filling”).

### Phase 3 — Hermes gateway + scheduled automations + document ingestion

Goal: PRD §14 phase 3 + the document-aware UI generation from arbitrary uploads.

1. Mattermost integration: provision a `careos-bot` user; Hermes gateway configured for Mattermost; per-home channels; DM pairing tied to Keycloak identity via a `/link` slash command that exchanges a one-time code with NestJS.
2. Cron automations via Hermes scheduler: nightly missing-mandatory-fields audit; weekly safeguarding digest; pre-shift handover reminder; expiring training certs alert. Each automation calls NestJS via MCP only; results are posted to Mattermost and to in-app inbox.
3. Document ingestion (`DocIngestWorkflow`): upload → MinIO → Docling extract (layout + tables) → Tesseract fallback for scanned images → schema-match heuristic (cosine similarity over pgvector of template descriptions) → render a generated form prefilled with extracted values → user confirms → write canonical record. This implements PRD’s “document-aware UI generation” end-to-end.
4. Approval modes: configure Hermes per-skill approval level (none / confirm / dual-sign-off) mirroring NestJS-side approval policy; align via a shared YAML in `packages/contracts`.

### Phase 4 — Compliance, reporting, exports, hardening

1. Reports module: pre-built KQL-style reports (incidents by type, by home, by month) using Postgres + materialized views; CSV + PDF export.
2. Ofsted-style serious incident export bundle: zipped PDF + JSON audit trail signed with org key, retained per retention policy table.
3. Retention jobs: configurable per record type; soft-delete + verified object deletion (`object_delete`) for attachments. (Amended: formerly "crypto-shred"; envelope-key shredding deferred.)
4. WCAG 2.2 AA audit pass; mobile responsive review; pen-test fixes; load test (k6) for 99.9% SLO targeting.
5. Optional: AKS Helm charts derived from Compose, with same image set; sealed-secrets; cert-manager; longhorn or Azure Files for PVCs.

---

## Relevant files / paths to be created

- `infra/compose/docker-compose.yml`, `infra/compose/caddy/Caddyfile`, `infra/keycloak/careos-realm.json`, `infra/grafana/dashboards/*.json`, `infra/otel/otel-collector.yaml`.
- `apps/api/src/auth/keycloak.strategy.ts`, `apps/api/src/common/tenant.guard.ts`, `apps/api/src/common/audit.interceptor.ts`, `apps/api/src/common/idempotency.interceptor.ts`, `apps/api/src/mcp/mcp.controller.ts`, `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/0001_init.sql` (RLS policies + audit triggers).
- `apps/web/app/(dashboard)/page.tsx` (mirror screenshot), `apps/web/app/(dashboard)/incidents/new/page.tsx`, `apps/web/components/schema-form/SchemaForm.tsx`, `apps/web/components/care-assistant/Panel.tsx`, `apps/web/lib/sse.ts`.
- `apps/worker/src/workflows/incident.workflow.ts`, `handover.workflow.ts`, `rota.workflow.ts`, `approval.workflow.ts`, `notification.workflow.ts`, `docIngest.workflow.ts`, plus `activities/hermes.ts`, `activities/gotenberg.ts`, `activities/docling.ts`, `activities/novu.ts`.
- `apps/agent/config.yaml`, `apps/agent/skills/careos/SKILL.md`, `apps/agent/skills/incident-drafting/`, `apps/agent/skills/handover-summary/`, `apps/agent/skills/email-drafting/`.
- `packages/schemas/incident.behavioural.v1.json`, etc.; `packages/contracts/openapi.yaml`, `packages/contracts/approval-policy.yaml`.

## Verification

1. **Compose up smoke**: `docker compose up -d`, then `curl https://localhost/health` → 200; Keycloak admin reachable; Temporal UI reachable; Grafana dashboards loaded; Hermes container logs show MCP handshake with NestJS.
2. **RLS contract test**: integration test that two requests with different `home_id` claims cannot see each other’s residents even via raw Prisma; trigger test confirms `UPDATE` on `audit.events` errors out.
3. **Incident E2E (Playwright)**: log in as support worker → type free-text prompt in Care Assistant → confirm generated draft → submit → log in as manager → approve → export PDF → verify audit trail has 5 events with correct `actor_kind`.
4. **Idempotency**: same `Idempotency-Key` replay produces identical response and no duplicate Temporal workflow.
5. **Schema-driven UI**: snapshot test renders `incident.behavioural.v1` form; changing the schema version produces a new form without code changes.
6. **Hermes safety**: Hermes asked to “send email to parents” without approval must stop at the approval gate (assertion against Temporal history).
7. **Observability**: a single user action produces a connected trace across `web → api → temporal → hermes → api`, viewable in Tempo/Grafana with the same `correlation_id`.
8. **Load**: k6 script — 50 RPS draft incidents for 10 min, p95 < 2 s for UI, < 3 s for first agent token.
9. **Accessibility**: axe-core CI gate on the four core screens.

## Decisions

- **Compose first**, AKS later via same images + Helm. K8s manifests are explicitly out of scope for MVP (Phase 4 optional).
- **NestJS** for the API (modules, guards, queues, OpenAPI, Temporal client ergonomics align with the domain weight).
- **Multi-home, single-tenant org**: one Postgres, RLS per `home_id`. Tenant column kept for future SaaS expansion.
- **Hermes Agent is the orchestration runtime, not the LLM**. Backing inference = **local OSS by default** (Ollama/OpenAI-compatible, model pinned by `CAREOS_LLM_MODEL`), with Azure AI Foundry / Azure OpenAI as optional adapters. All model traffic flows through the internal `llm-gateway` with PII redaction, per-tenant budgets, and OTel spans. No cloud LLM provider keys live outside Docker secrets / Entra Workload Identity, and no cloud credential is required for local dev or CI.
- **Hermes only touches domain state via the NestJS MCP server**. No direct DB access, no shared secrets store with the app DB.
- **Temporal owns deterministic workflow state**; Hermes owns conversational/agentic state. Both are written into audit on every step.
- **Mattermost is the staff comms channel and a Hermes gateway target** (replaces Slack/Telegram for private-server, on-prem operation).
- **Novu** for notifications (email + in-app); SMTP relay self-hosted (Postfix container) or BYO provider.
- **Docling + Tesseract + Gotenberg** for the full doc loop; Docling first (structured), Tesseract fallback (scanned).
- **Out of scope for MVP**: medication administration record (MAR), resident-facing app, payroll/finance/HR, marketplace integrations, SMS/voice (PRD §3.2).
- **Open source posture**: every container is OSS-licensed; no proprietary cloud SDKs in critical path. AGPL components (Mattermost Team Edition, MinIO AGPLv3) used as standalone services, not linked — keeps your distribution licensing clean.

## Further considerations

1. **Azure subscription + region.** UK residents’ data → strong preference for **UK South** (primary) + **UK West** (paired) for Azure OpenAI + Foundry deployments to satisfy ICO/Ofsted expectations. Confirm: (a) which Azure subscription owns the Foundry project, (b) whether AOAI capacity is already approved in UK South for the chosen models, (c) whether you want Foundry **content safety** filters enabled by default (recommend yes — built-in jailbreak + harmful-content shields are valuable for safeguarding data).
2. **Auth to Azure: key vs Entra Workload Identity.** (A) API keys in Docker secrets (simplest for VPS Compose); rotate quarterly via `az cognitiveservices account keys regenerate`. (B) Entra **federated credentials** from the VPS using an Azure-issued cert + Workload Identity Federation (no long-lived secrets, but more setup). Recommend **A** for the pilot, **B** before going multi-home production.
3. **Model picks per task** (initial).
   - `draft.high-stakes` (incident, safeguarding, external email) → AOAI **gpt-4.1** (or gpt-4o) — strong reasoning, JSON mode, content-safety.
   - `summarize` / `extract-structured` from handover free text → AOAI **gpt-4o-mini** (cheap, fast).
   - `chat.general` (Care Assistant panel + Mattermost) → Foundry **Llama-3.3-70B-Instruct** or **Phi-4** deployment for cost; fall back to gpt-4o-mini on quality failures.
   - `embed` → AOAI **text-embedding-3-large** into pgvector.
   - **NousResearch Hermes models** in Foundry catalog: if/when available in your region, route `chat.general` to them to honour the “Hermes must be used” constraint at both the agent runtime _and_ the model layer.
4. **Auth provider.** Keycloak (chosen) vs Authentik. Sticking with Keycloak.
5. **Rota solver.** TS heuristic for MVP; MiniZinc/OR-Tools sidecar in Phase 4 if managers ask for true optimization.
