#!/usr/bin/env bash
# Bring up (or refresh) the Kid-OS local stack via Docker Compose.
#
# Usage:
#   scripts/dev-up.sh                 # build (if needed) + start everything detached
#   scripts/dev-up.sh api web         # rebuild + restart only the listed services
#   scripts/dev-up.sh --no-build      # start without rebuilding any image
#   scripts/dev-up.sh --status        # print container status + first-time login info
#   scripts/dev-up.sh --down          # stop the stack (volumes preserved)
#   scripts/dev-up.sh --nuke          # stop + remove volumes (full reset)
#
# Idempotent: re-run any time after pulling code or editing a Dockerfile.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/docker-compose.yml"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-careos}"

compose() {
  local compose_args=(-p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  if [[ -n "$COMPOSE_OVERRIDE_FILE" ]]; then
    compose_args+=(-f "$COMPOSE_OVERRIDE_FILE")
  fi
  docker compose "${compose_args[@]}" "$@"
}

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "[dev-up] .env not found, copying from .env.example"
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    generate_local_secrets
  fi
}

# Replace `change-me` placeholders with generated values on first boot so a
# local stack never runs on known-default secrets. Services that refuse
# `change-me` (export signing, Mattermost webhook) work out of the box.
generate_local_secrets() {
  if ! command -v openssl >/dev/null 2>&1; then
    echo "[dev-up] WARNING: openssl not found; .env keeps change-me placeholders" >&2
    return
  fi
  echo "[dev-up] generating local secrets in .env"
  local var
  for var in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD REDIS_PASSWORD \
    KEYCLOAK_ADMIN_PASSWORD KEYCLOAK_API_CLIENT_SECRET KEYCLOAK_MCP_CLIENT_SECRET \
    MINIO_ROOT_PASSWORD EXPORT_BUNDLE_SIGNING_KEY LLM_GATEWAY_SERVICE_TOKEN NEXTAUTH_SECRET \
    MATTERMOST_BOT_WEBHOOK_TOKEN GRAFANA_ADMIN_PASSWORD NOVU_API_KEY NOVU_JWT_SECRET; do
    local secret
    secret="$(openssl rand -hex 24)"
    sed -i "s|^${var}=change-me.*$|${var}=${secret}|" "$ENV_FILE"
  done
  # Postgres URLs embed the passwords; rewrite them to match.
  local pg_app pg_owner
  pg_app="$(grep '^POSTGRES_APP_PASSWORD=' "$ENV_FILE" | cut -d= -f2)"
  pg_owner="$(grep '^POSTGRES_PASSWORD=' "$ENV_FILE" | cut -d= -f2)"
  sed -i "s|^DATABASE_URL=.*$|DATABASE_URL=postgresql://careos_app:${pg_app}@postgres:5432/careos?schema=public|" "$ENV_FILE"
  sed -i "s|^MIGRATION_DATABASE_URL=.*$|MIGRATION_DATABASE_URL=postgresql://careos:${pg_owner}@postgres:5432/careos?schema=public|" "$ENV_FILE"
}

print_status() {
  echo
  echo "[dev-up] Container status:"
  compose ps
  cat <<'EOF'

[dev-up] Endpoints:
  Web (NextAuth)           https://localhost/
  API (NestJS)             https://localhost/api/
  Keycloak admin           https://localhost/keycloak/   (admin / see .env)
  Temporal UI              https://localhost/temporal/
  Grafana                  https://localhost/grafana/    (admin / see .env)
  MinIO S3 API             https://localhost/minio/
  MinIO console            https://localhost/minio-console/ (careos / see .env)

[dev-up] Seeded users (all password: careos-dev-password):
  manager@careos.local            (manager)
  shift.lead@careos.local         (shift_lead)
  support.worker@careos.local     (support_worker)
  ash.support@careos.local        (support_worker, Ash House)
  safeguarding.lead@careos.local  (safeguarding_lead)
  ops.admin@careos.local          (ops_admin)

[dev-up] Demo data: migrate + seed-demo compose jobs run automatically
  (CAREOS_SEED_DEMO=true in .env). API /ready fails until migrations apply.

[dev-up] Self-signed cert: accept it once in the browser, or use --insecure with curl.
EOF
}

cmd="${1-}"
case "$cmd" in
  --status)
    ensure_env
    print_status
    ;;
  --down)
    ensure_env
    compose down --remove-orphans
    ;;
  --nuke)
    ensure_env
    compose down -v --remove-orphans
    ;;
  --no-build)
    ensure_env
    shift || true
    compose up -d --wait --wait-timeout 600 "$@"
    print_status
    ;;
  "")
    ensure_env
    compose up -d --build --wait --wait-timeout 900
    print_status
    ;;
  *)
    # treat positional args as service names: rebuild + restart just those
    ensure_env
    compose up -d --build --wait --wait-timeout 900 "$@"
    print_status
    ;;
esac
