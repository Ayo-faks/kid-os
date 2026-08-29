#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/infra/compose/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.example}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-careos-phase1-trace}"
PUBLIC_BASE_URL="${PHASE1_PUBLIC_BASE_URL:-https://localhost}"
GRAFANA_URL="${PHASE1_GRAFANA_URL:-$PUBLIC_BASE_URL/grafana}"
CORRELATION_ID="${PHASE1_CORRELATION_ID:-phase1-$(date -u +%Y%m%dT%H%M%SZ)}"
EVIDENCE_ROOT="${CAREOS_EVIDENCE_ROOT:-$ROOT_DIR/.tmp/release-evidence}"
EVIDENCE_DIR="${PHASE1_EVIDENCE_DIR:-$EVIDENCE_ROOT/phase1}"
SCREENSHOT_PATH="${PHASE1_SCREENSHOT_PATH:-$EVIDENCE_DIR/create-incident-from-prompt.png}"
EVIDENCE_DOC="${PHASE1_EVIDENCE_DOC:-$EVIDENCE_DIR/trace-evidence.md}"
DOCKER_CONFIG_TEMP=""
read -r -a TRACE_SERVICES <<< "${PHASE1_TRACE_SERVICES:-caddy web api worker hermes llm-gateway grafana tempo otel-collector temporal temporal-ui keycloak postgres}"

export CAREOS_E2E_AUTH_BYPASS=true
export CAREOS_E2E_STATIC_DATA=true
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-4}"
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
export PHASE1_CORRELATION_ID="$CORRELATION_ID"

if [[ -z "${DOCKER_CONFIG:-}" ]]; then
  TMP_PARENT="${TMPDIR:-$ROOT_DIR/.tmp}"
  mkdir -p "$TMP_PARENT"
  DOCKER_CONFIG_TEMP="$(mktemp -d "$TMP_PARENT/careos-docker-config.XXXXXX")"
  export DOCKER_CONFIG="$DOCKER_CONFIG_TEMP"
fi

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  if [[ "${PHASE1_TRACE_KEEP_COMPOSE:-false}" != "true" ]]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ -n "$DOCKER_CONFIG_TEMP" ]]; then
    rm -rf "$DOCKER_CONFIG_TEMP"
  fi
}

urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

grafana_tempo_url() {
  node -e '
const base = new URL(process.argv[1]);
const query = process.argv[2];
base.pathname = base.pathname.replace(/\/$/, "") + "/explore";
base.searchParams.set("orgId", "1");
base.searchParams.set("left", JSON.stringify({
  datasource: "tempo",
  queries: [{ query, queryType: "traceql", refId: "A" }],
  range: { from: "now-30m", to: "now" },
}));
process.stdout.write(base.toString());
' "$GRAFANA_URL" "$1"
}

trap cleanup EXIT

cd "$ROOT_DIR"
mkdir -p "$EVIDENCE_DIR"

compose config --quiet
compose build api web worker hermes keycloak
compose up --wait --wait-timeout 900 -d "${TRACE_SERVICES[@]}" || {
  compose ps >&2 || true
  compose logs --tail=160 >&2 || true
  exit 1
}

curl -kfsS "$PUBLIC_BASE_URL/health" >/dev/null

PLAYWRIGHT_BASE_URL="$PUBLIC_BASE_URL" \
PLAYWRIGHT_SKIP_WEB_SERVER=true \
PHASE1_CORRELATION_ID="$CORRELATION_ID" \
pnpm --filter @careos/e2e test

pnpm --filter @careos/e2e exec playwright screenshot \
  --full-page \
  --ignore-https-errors \
  "$PUBLIC_BASE_URL/incidents/new" \
  "$SCREENSHOT_PATH"

trace_payload="$(curl -kfsS -H "x-careos-trace-probe: phase1-$CORRELATION_ID" "$PUBLIC_BASE_URL/api/observability/trace")"
trace_id="$(node -e 'const fs = require("node:fs"); const payload = JSON.parse(fs.readFileSync(0, "utf8")); process.stdout.write(payload.traceId ?? "");' <<< "$trace_payload")"

curl -kfsS \
  -H "x-careos-correlation-id: $CORRELATION_ID" \
  "$PUBLIC_BASE_URL/api/mcp/tools/list-form-templates" >/dev/null

compose exec -T hermes python - "$CORRELATION_ID" <<'PY'
import json
import sys
from urllib.request import Request, urlopen

correlation_id = sys.argv[1]
payload = {
    "id": correlation_id,
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {"arguments": {}, "name": "list_form_templates"},
}
request = Request(
    "http://127.0.0.1:8080/mcp",
    data=json.dumps(payload).encode("utf-8"),
    headers={"content-type": "application/json", "x-careos-correlation-id": correlation_id},
    method="POST",
)
urlopen(request, timeout=10).read()
PY

compose exec -T llm-gateway wget -q -O- http://127.0.0.1:8080/health >/dev/null
compose exec -T temporal temporal operator cluster health --address temporal:7233 >/dev/null

traceql="{resource.service.name=~\"web|api|worker|hermes|llm-gateway\" && careos.correlation_id=\"$CORRELATION_ID\"}"
tempo_query_url="$(grafana_tempo_url "$traceql")"
encoded_correlation_id="$(urlencode "$CORRELATION_ID")"

cat > "$EVIDENCE_DOC" <<EOF
# Phase 1 Trace Evidence

Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

- Correlation ID: \`$CORRELATION_ID\`
- API trace probe ID: \`$trace_id\`
- Tempo query: [$traceql]($tempo_query_url)
- Correlation search: [$CORRELATION_ID]($GRAFANA_URL/explore?orgId=1&search=$encoded_correlation_id)
- Screenshot: [$SCREENSHOT_PATH]($SCREENSHOT_PATH)

## Evidence Path

The script runs the Playwright create-incident-from-prompt suite against the compose web surface at \`$PUBLIC_BASE_URL\`, captures the incident creation page with the visible correlation ID, and probes the Phase 1 observability chain:

1. web: Playwright drives \`/incidents/new\` and captures the visible correlation ID.
2. api: \`/api/observability/trace\` emits the API trace probe span.
3. temporal: Temporal cluster health is checked in the compose network.
4. hermes: Hermes \`list_form_templates\` is invoked over JSON-RPC.
5. llm-gateway: the gateway health endpoint is checked in the compose network.
6. api(mcp): \`/api/mcp/tools/list-form-templates\` is called through Caddy.
EOF

printf '[phase1-trace] wrote %s\n' "$EVIDENCE_DOC"