# Kid-OS

Kid-OS is an open-source, multi-home residential child-care operations platform.
The workspace contains a Next.js web app, NestJS API, Temporal worker, optional
Durable Task runtime, Hermes agent, provider-neutral LLM gateway, Keycloak,
tenant-isolated Postgres, Redis, object storage, and OpenTelemetry observability.

> **Pre-release:** Kid-OS is not certified for production safeguarding, UK GDPR,
> Ofsted, NHS, medical, legal, or other regulatory requirements. Use synthetic
> data only while evaluating or contributing to the project.

See [`docs/plan.md`](docs/plan.md) for the architecture and
[`docs/phase4-hardening.md`](docs/phase4-hardening.md) for the current security,
accessibility, and operational hardening checklist.

## Open-Source Transition

The code is being prepared for release under the
[Apache License 2.0](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
before contributing or redistributing a bundled deployment.

Legacy `careos` package, protocol, identity, database, workflow, storage, and
Azure identifiers remain in place during the compatibility-first rename. They
must not be globally replaced without a migration and rollback plan.

## Project Status

The source is public for evaluation, learning, and collaboration while the
project is still under active development. The third-party distribution review
is not complete, so there is no supported binary, container bundle, managed
service, or production release yet.

The initial public project supports local development through Docker Compose.
Private deployment automation, live environment configuration, and release
evidence are intentionally not part of this repository.

## Prerequisites

- Node `>=24` (see `.nvmrc`)
- pnpm `>=10`
- Docker + Docker Compose v2
- Python 3.11 (only for `apps/agent` local dev — the container builds its own)

## Quick start (dev)

```bash
pnpm install
cp .env.example .env   # fill in secrets
pnpm dev               # turbo runs every app's dev task
```

Compose stack:

```bash
docker compose -f infra/compose/docker-compose.yml up -d
```

## Workspace layout

```
apps/
  web/        Next.js App Router + shadcn/ui
  api/        NestJS (Fastify) + Prisma + OpenAPI
  worker/     Temporal TypeScript worker
  agent/      Hermes Agent (Python) — config + skills only
  llm-gateway/ Provider-neutral model routing, privacy, and budgets
packages/
  contracts/  Shared Zod schemas + generated OpenAPI client
  ui/         shadcn primitives shared across surfaces
  schemas/    JSON Schemas for schema-driven forms
  object-storage/ MinIO/Azure Blob provider boundary
  tsconfig/   Shared TypeScript base configs
infra/
  compose/    docker-compose.yml + service init
  keycloak/   realm import
  caddy/      reverse proxy + dev TLS
  otel/       collector config
  grafana/    datasources + dashboards
```

## Scripts

- `pnpm dev` — run every app in dev mode (turbo)
- `pnpm lint` — ESLint across the workspace
- `pnpm typecheck` — `tsc --noEmit` in every package
- `pnpm test` — Vitest across the workspace
- `pnpm build` — production builds

## Project Governance

Changes should arrive through pull requests with the `CI` workflow green.
Commits follow Conventional Commits (see `commitlint.config.cjs`) and require a
DCO sign-off. Repository rules will be tightened as the pre-release maintainer
group grows.
