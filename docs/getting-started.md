# Getting Started

This guide starts a local Kid-OS development environment with synthetic data.
It does not describe a production deployment.

## Requirements

### Compose-only evaluation

- Git
- Docker Engine or Docker Desktop
- Docker Compose v2 (`docker compose version`)
- OpenSSL, recommended for generated local secrets

### Host-side development

- Node.js 24 or later
- pnpm 10 or later
- Python 3.11 or later for the Hermes agent tests

The default environment is a multi-container stack. The first build can take
several minutes and requires enough memory and disk for PostgreSQL, Keycloak,
Temporal, Docling, the application services, and the observability stack.

## 1. Clone

```bash
git clone https://github.com/Ayo-faks/kid-os.git
cd kid-os
```

## 2. Start

```bash
./scripts/dev-up.sh
```

Do not copy `.env.example` manually for the normal path. When `.env` is absent,
`dev-up.sh` copies it and uses OpenSSL to replace known local secret
placeholders. If OpenSSL is unavailable, the script warns and retains the
development placeholders; install OpenSSL and recreate `.env` before relying on
that environment for anything beyond isolated evaluation.

The helper runs Compose with health waiting enabled. It also runs two one-shot
jobs:

- `migrate` applies every committed Prisma migration;
- `seed-demo` loads deterministic synthetic homes, users, residents, forms,
  shifts, and workflow fixtures when `CAREOS_SEED_DEMO=true`.

## 3. Trust the Local Connection

Caddy serves HTTPS with a local development certificate. Navigate to
<https://localhost> and accept the browser warning for this local environment.
For command-line health checks, use `curl -k` as shown below.

Do not reuse this certificate or configuration for an internet-facing system.

## 4. Sign In

All seeded application users use the password `careos-dev-password`.

| User                             | Role                     |
| -------------------------------- | ------------------------ |
| `manager@careos.local`           | Manager                  |
| `shift.lead@careos.local`        | Shift lead               |
| `support.worker@careos.local`    | Support worker           |
| `ash.support@careos.local`       | Ash House support worker |
| `safeguarding.lead@careos.local` | Safeguarding lead        |
| `ops.admin@careos.local`         | Operations administrator |

These are synthetic local identities. The legacy `careos.local` realm naming
is retained as a compatibility contract during the Kid-OS rename.

Administrative passwords are generated into `.env` on first start:

- Keycloak: `KEYCLOAK_ADMIN_PASSWORD`
- Grafana: `GRAFANA_ADMIN_PASSWORD`
- MinIO: `MINIO_ROOT_PASSWORD`

Never commit `.env`.

## 5. Verify Readiness

```bash
./scripts/dev-up.sh --status
curl -kfsS https://localhost/health
curl -kfsS https://localhost/api/ready
```

`/api/ready` verifies more than process liveness: it remains unavailable until
the expected database migrations have been applied.

| Service                 | Address                            |
| ----------------------- | ---------------------------------- |
| Kid-OS web              | <https://localhost/>               |
| API                     | <https://localhost/api/>           |
| API health              | <https://localhost/api/health>     |
| API migration readiness | <https://localhost/api/ready>      |
| Keycloak                | <https://localhost/keycloak/>      |
| Temporal UI             | <https://localhost/temporal/>      |
| Grafana                 | <https://localhost/grafana/>       |
| MinIO S3 API            | <https://localhost/minio/>         |
| MinIO console           | <https://localhost/minio-console/> |

## Optional Profiles

The default stack uses Temporal and starts no local model. Enable optional
profiles through `COMPOSE_PROFILES`:

| Profile               | Purpose                                                   |
| --------------------- | --------------------------------------------------------- |
| `llm`                 | Start Ollama and pull the pinned local model              |
| `durable`             | Start the Durable Task Scheduler emulator                 |
| `novu-optional`       | Start the optional Novu service                           |
| `mattermost-optional` | Start Mattermost Team Edition; reviewed for `linux/amd64` |

Example:

```bash
COMPOSE_PROFILES=llm ./scripts/dev-up.sh
```

To persist profiles, set `COMPOSE_PROFILES` in `.env` and rerun the helper.

## Common Development Operations

### Install host dependencies

```bash
pnpm install --frozen-lockfile
```

### Run application processes from the host

`pnpm dev` starts workspace development tasks. Supporting services such as
PostgreSQL, Redis, Keycloak, Temporal, and object storage must already be
available with matching environment configuration. For most contributors, the
Compose path is the reliable first start.

### Rebuild selected services

```bash
./scripts/dev-up.sh api web
./scripts/dev-up.sh worker hermes
```

### Start without rebuilding

```bash
./scripts/dev-up.sh --no-build
```

### Follow logs

```bash
docker compose \
  --env-file .env \
  -f infra/compose/docker-compose.yml \
  logs -f api web worker hermes
```

### Stop and preserve data

```bash
./scripts/dev-up.sh --down
```

### Full local reset

```bash
./scripts/dev-up.sh --nuke
```

`--nuke` permanently removes the local PostgreSQL, Redis, Temporal, MinIO, and
observability volumes for this Compose project.

## Validation Commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:agent
pnpm build
pnpm ci:openapi
pnpm ci:prisma
pnpm ci:supply-chain
pnpm ci:open-source:public
```

Run the disposable integration smoke test after changes to containers,
authentication, migrations, service routing, or health checks:

```bash
./scripts/compose-smoke.sh
```

The smoke script creates an isolated Compose project, verifies the public edge,
API trace probe and migration readiness, Keycloak realm, Temporal UI, Grafana,
MinIO buckets, and Hermes readiness, then removes its volumes.

## Troubleshooting

### A port is already in use

The default edge binds host ports 80 and 443, and Keycloak also exposes 8080.
Stop the conflicting process or update the relevant values in `.env`. Keep
`NEXTAUTH_URL`, issuer URLs, and public endpoints consistent when changing the
edge address.

### A service is unhealthy

```bash
docker compose --env-file .env -f infra/compose/docker-compose.yml ps
docker compose --env-file .env -f infra/compose/docker-compose.yml logs --tail=200
```

Keycloak, Temporal, and Docling have longer first-start health windows. Check
their logs before resetting the stack.

### The assistant cannot reach a model

The default stack does not start Ollama. Start the `llm` profile or configure an
explicit gateway provider in `.env`. Model traffic must continue to pass through
`llm-gateway`.

### Local state no longer matches migrations

Use `./scripts/dev-up.sh --nuke` only when you are willing to delete all local
data, then run `./scripts/dev-up.sh` to bootstrap a fresh synthetic environment.

### The browser rejects HTTPS

The local Caddy CA is intentionally not installed into the host trust store.
Accept the local browser warning, or use `curl -k` for health checks. Never
disable certificate verification for a non-local environment.

## Next Reading

- [Architecture](architecture.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Hardening status](phase4-hardening.md)
- [Architecture decisions and roadmap](plan.md)
