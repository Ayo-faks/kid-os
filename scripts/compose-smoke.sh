#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/infra/compose/docker-compose.yml}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.example}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-careos-ci}"
SMOKE_BASE_URL="${SMOKE_BASE_URL:-https://localhost}"
DOCKER_CONFIG_TEMP=""
read -r -a SMOKE_SERVICES <<< "${SMOKE_SERVICES:-caddy hermes worker}"

export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-4}"

if [[ -z "${DOCKER_CONFIG:-}" ]]; then
  TMP_PARENT="${TMPDIR:-$ROOT_DIR/.tmp}"
  mkdir -p "$TMP_PARENT"
  DOCKER_CONFIG_TEMP="$(mktemp -d "$TMP_PARENT/careos-docker-config.XXXXXX")"
  export DOCKER_CONFIG="$DOCKER_CONFIG_TEMP"
fi

compose() {
  local compose_args=(-p "$PROJECT_NAME" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
  if [[ -n "$COMPOSE_OVERRIDE_FILE" ]]; then
    compose_args+=(-f "$COMPOSE_OVERRIDE_FILE")
  fi
  docker compose "${compose_args[@]}" "$@"
}

cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  if [[ -n "$DOCKER_CONFIG_TEMP" ]]; then
    rm -rf "$DOCKER_CONFIG_TEMP"
  fi
}

check_url() {
  local url="$1"
  local label="$2"

  if curl -kfsS "$url" >/dev/null; then
    printf '[compose-smoke] %s ok\n' "$label"
    return 0
  fi

  printf '[compose-smoke] %s failed: %s\n' "$label" "$url" >&2
  compose ps >&2 || true
  return 1
}

trap cleanup EXIT

cd "$ROOT_DIR"

compose config --quiet
compose build api web worker hermes keycloak
compose up --wait --wait-timeout 900 -d "${SMOKE_SERVICES[@]}" || {
  compose ps >&2 || true
  compose logs --tail=120 >&2 || true
  exit 1
}

check_url "$SMOKE_BASE_URL/health" caddy-health
check_url "$SMOKE_BASE_URL/api/observability/trace" api-trace-probe
check_url "$SMOKE_BASE_URL/keycloak/realms/careos/.well-known/openid-configuration" keycloak-realm
check_url "$SMOKE_BASE_URL/temporal/" temporal-ui
check_url "$SMOKE_BASE_URL/grafana/api/health" grafana

# Domain readiness: /ready now proves every shipped Prisma migration is
# applied (the migrate one-shot job ran), not just that Postgres answers.
check_url "$SMOKE_BASE_URL/api/ready" api-ready-migrations

# Seeded domain data: when the smoke env enables CAREOS_SEED_DEMO, the seeded
# tenant + form templates must exist — a fresh install must be usable.
if grep -q '^CAREOS_SEED_DEMO=true' "$ENV_FILE"; then
  compose exec -T postgres psql -U careos -d careos -tAc \
    "SELECT count(*) FROM core.form_templates WHERE tenant_id = '10000000-0000-4000-8000-000000000001'" \
    | grep -qE '^[1-9]' || {
      printf '[compose-smoke] seeded form templates missing\n' >&2
      exit 1
    }
  printf '[compose-smoke] seed-demo ok\n'
fi

# Buckets: verify through MinIO's API; backend filesystem layout is not public.
compose run --rm --no-deps --entrypoint /bin/sh minio-init -ec '
  mc alias set careos http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  mc stat careos/careos-documents >/dev/null
  mc stat careos/careos-export-bundles >/dev/null
' || {
  printf '[compose-smoke] required MinIO buckets missing\n' >&2
  exit 1
}
printf '[compose-smoke] minio buckets ok\n'

compose exec -T hermes python - <<'PY'
from urllib.request import urlopen

urlopen('http://127.0.0.1:8080/ready', timeout=5).read()
PY

compose logs hermes | grep -q '\[hermes\] listening'
printf '[compose-smoke] hermes ok\n'