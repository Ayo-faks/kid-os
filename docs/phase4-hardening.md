# Phase 4 — Hardening notes

This document captures the Phase 4 hardening checklist required by
`docs/plan.md`: WCAG 2.2 AA accessibility, mobile review, security
pen-test items, and the load-test profile underpinning the 99.9% SLO.
It is not a one-off audit report — it lists what is verified in CI and
what must be repeated manually before any production cutover.

## 1. Accessibility — WCAG 2.2 AA

Automated coverage already exists from earlier phases and is rerun on
every PR by the existing `phase1-verification` / `phase2-verification`
jobs:

- `apps/web/e2e/e2e/create-incident-from-prompt.spec.ts`
- `apps/web/e2e/e2e/resident-timeline.spec.ts`
- `apps/web/e2e/e2e/approvals.spec.ts`
- `apps/web/e2e/e2e/start-shift-end-handover.spec.ts`
- `apps/web/e2e/e2e/draft-email.spec.ts`
- `apps/web/e2e/e2e/rota.spec.ts`
- `apps/web/e2e/e2e/dashboard.spec.ts`

Each spec runs `@axe-core/playwright` with the `wcag22aa` tag enabled.
Two manual checks are still required before any release candidate:

- Keyboard-only walkthrough of the create-incident, approvals,
  handover, rota, and reports flows. Visible focus rings must be
  present on every interactive element (Tailwind `focus-visible:`
  utilities ship with the design system).
- Screen-reader smoke (NVDA on Windows, VoiceOver on macOS) of the
  same flows. Confirm form labels, error summaries, and live regions
  for `aria-live="polite"` announcements on async submit.

WCAG 2.2-specific success criteria to spot-check manually (the rule
set most likely to regress between automated runs):

- 2.4.11 Focus Not Obscured — sticky headers/footers must not hide
  the focused element.
- 2.5.7 Dragging Movements — any drag interaction (e.g. future rota
  editor) must offer a click/keyboard alternative.
- 2.5.8 Target Size — interactive controls ≥ 24×24 CSS px.
- 3.3.7 Redundant Entry — pre-fill repeated incident fields.
- 3.3.8 Accessible Authentication — Keycloak handles password and
  passkey flows; verify no extra CAPTCHA gates the test users.

## 2. Mobile review

The web app is built mobile-first with Tailwind breakpoints. Manual
checks before release:

- iPhone SE (375 × 667) and Pixel 7 (412 × 915) — incident creation,
  handover end, approvals queue, dashboard tiles.
- 200 % zoom on a 1280-wide viewport (WCAG 1.4.10 Reflow).
- Hit-target spacing on the rota gap badge and approval sign-off
  badge.
- Soft-keyboard handling on free-text fields (`autocomplete`,
  `inputmode`, `enterkeyhint` should be set on incident free-text).

## 3. Pen-test / security checklist

Items below are either enforced by code/CI or covered by automated
tests; the manual column is reserved for review before release.

| Area                      | Enforcement                                                                                                                                                                                                                                                                                              | Manual check                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| AuthN                     | Keycloak OIDC; API rejects unsigned JWTs in `JwtAuthGuard`                                                                                                                                                                                                                                               | Verify `kid` rotation works against staging realm                                                                                 |
| AuthZ                     | `RolesGuard` + `@Roles(...)` on every controller; covered by `apps/api/src/common/roles.guard.test.ts`                                                                                                                                                                                                   | Spot-check new Phase 4 endpoints (`/reports/*`, `/export-bundles*`, `/retention/*`) reject unauthenticated and wrong-role callers |
| Tenant/home isolation     | Postgres RLS via `app.current_tenant_id` / `app.current_home_id` GUCs in every `$transaction`; integration tests (`apps/api/src/incidents/__tests__/incidents.integration.test.ts`, `apps/api/src/handovers/...`, `apps/api/src/approvals/...`) cover cross-tenant denials                               | Re-run integration suite after any new direct-SQL access                                                                          |
| Audit append-only         | `audit.events` insert-only trigger; integration tests cover UPDATE/DELETE denial                                                                                                                                                                                                                         | n/a                                                                                                                               |
| Prompt-injection (Hermes) | `draft_incident_from_text`, `draft_email`, `narrate_rota`, `summarize_handover` refuse mutation triggers and return empty `form_data` with `refused: true`. Coverage in `apps/agent/tests/test_draft_email.py`, `test_draft_incident_from_text.py`, `test_narrate_rota.py`, `test_summarize_handover.py` | Re-run agent suite after any system-prompt edit                                                                                   |
| PII                       | API LLM gateway redacts/rehydrates names + identifiers (`apps/api/src/assistant/...`); covered by API integration                                                                                                                                                                                        | Confirm `llm-gateway` Caddy config still forces egress through gateway                                                            |
| Idempotency               | `Idempotency-Key` replay returns prior response without re-running side effects; covered by incident/handover/email-draft integration                                                                                                                                                                    | n/a                                                                                                                               |
| Export bundle integrity   | Bundles are HMAC-SHA256-signed with `EXPORT_BUNDLE_SIGNING_KEY` (rejected when unset or `change-me`); manifest sha256 stored in `core.export_bundles.manifest_sha256`                                                                                                                                    | Rotate signing key in staging and verify previous bundles still validate via stored signature                                     |
| Retention                 | Soft-delete columns + `core.retention_runs` audit trail; daily Temporal Schedule `careos.retention-sweep` registered automatically by worker boot; covered by `apps/worker/src/activities/retention.test.ts` and `apps/worker/src/schedules/retention-sweep.test.ts`                                     | Confirm policies seeded per tenant before enabling                                                                                |
| Secrets                   | `change-me` placeholders fail loudly (Mattermost bot token, export bundle signing key, Hermes API key). Trivy + SBOM gates in CI                                                                                                                                                                         | Re-scan images on every release                                                                                                   |
| Dependencies              | Renovate + npm/pnpm audit on PRs; SBOM uploaded as CI artifact                                                                                                                                                                                                                                           | Review high/critical advisories weekly                                                                                            |
| Transport                 | All traffic terminates at Caddy with HSTS; internal services use the compose network only                                                                                                                                                                                                                | Confirm `Caddyfile` matches production hostnames                                                                                  |
| CSRF                      | API is JWT-bearer only (no cookie auth from the SPA); no state-changing form posts                                                                                                                                                                                                                       | Verify any new server actions in Next.js include explicit `Origin` checks                                                         |

## 4. Load profile (99.9% SLO)

The load script at [scripts/k6/incidents-load.js](scripts/k6/incidents-load.js)
holds 50 RPS of `POST /incidents` for 10 minutes via a
`constant-arrival-rate` executor. Thresholds:

- `http_req_duration` p95 < 2s, p99 < 3s
- `http_req_failed` rate < 0.001 (≤ 0.1 %)

CI can run the `smoke` profile (`K6_PROFILE=smoke`, 1 VU × 30 iterations)
on every PR; the full 10-minute run is reserved for release candidates
against a staging stack with realistic data volumes.

To execute against a local compose stack:

```sh
export K6_TOKEN=$(curl -s ... | jq -r .access_token)
k6 run -e BASE_URL=http://localhost:8080 -e K6_TOKEN=$K6_TOKEN scripts/k6/incidents-load.js
```

If thresholds are breached, the immediate triage path is:

1. Inspect the Grafana "API latency" dashboard for hot spans.
2. Pull the Tempo trace for the slowest request.
3. Check Temporal worker queue depth — incidents draft creation enqueues
   the `IncidentDraftWorkflow` on `careos.incidents`.

## 5. Out of scope (deferred)

- Optional AKS migration (per `docs/plan.md` Phase 4 marks it
  optional; no work in this phase).

## 6. Phase 4 follow-ups (delivered)

- **Real MinIO upload of export bundles.** `composeExportBundle` now
  builds a real ZIP (incident JSON, audit trail, signed manifest,
  `signature.txt`) and uploads to `MINIO_EXPORT_BUNDLES_BUCKET` when
  `MINIO_EXPORT_BUNDLES_ENABLED=true`. Disabled mode is preserved for
  CI / dev installs without a MinIO daemon. Manager / safeguarding /
  ops-admin roles can mint a 5-minute presigned URL via
  `GET /export-bundles/:id/download`, which also appends an
  `export_bundle.downloaded` row to `audit.events`.
- **Per-document Docling/OCR.** `DocIngestWorkflow` now sequences
  `markExtracting → loadDocumentForExtraction → extractDocument →
markExtracted` with a 10-minute activity timeout. The compose stack
  ships a `docling-serve` sidecar (`ghcr.io/docling-project/docling-serve`)
  and `DOCLING_URL` is wired into the worker. When the env var is unset
  or `change-me`, the activity short-circuits to empty text with
  `reason: 'docling-disabled'` so tests stay deterministic.
