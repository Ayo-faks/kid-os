#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/infra/compose/docker-compose.yml}"
COMPOSE_OVERRIDE_FILE="${COMPOSE_OVERRIDE_FILE:-}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.example}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-careos-phase4-real-${GITHUB_RUN_ID:-local}}"
PUBLIC_BASE_URL="${PHASE4_PUBLIC_BASE_URL:-https://localhost}"
PUBLIC_AUTHORITY="${PUBLIC_BASE_URL#*://}"
DOCKER_CONFIG_TEMP=""

if [[ "$PUBLIC_AUTHORITY" == "$PUBLIC_BASE_URL" || "$PUBLIC_AUTHORITY" == */* ]]; then
  printf 'PHASE4_PUBLIC_BASE_URL must contain only an absolute origin.\n' >&2
  exit 1
fi

export AUTO_REGISTER_SCHEDULES=false
export CAREOS_E2E_AUTH_BYPASS=false
export CAREOS_E2E_STATIC_DATA=false
export CAREOS_SEED_DEMO=true
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-4}"
export COMPOSE_PROJECT_NAME="$PROJECT_NAME"
export EXPORT_BUNDLE_SIGNING_KEY=phase4-real-stack-test-only-signing-key
export KEYCLOAK_ISSUER="${KEYCLOAK_ISSUER:-$PUBLIC_BASE_URL/keycloak/realms/careos}"
export KEYCLOAK_PUBLIC_URL="${KEYCLOAK_PUBLIC_URL:-$PUBLIC_BASE_URL}"
export MINIO_PUBLIC_ENDPOINT="${MINIO_PUBLIC_ENDPOINT:-$PUBLIC_BASE_URL/minio}"
export MINIO_EXPORT_BUNDLES_ENABLED=false
export NEXTAUTH_URL="${NEXTAUTH_URL:-$PUBLIC_BASE_URL}"
export PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME:-$PUBLIC_AUTHORITY}"

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

wait_for_readiness() {
  local response_file
  local status
  response_file="$(mktemp "${TMPDIR:-$ROOT_DIR/.tmp}/careos-readiness.XXXXXX")"

  for ((attempt = 1; attempt <= 90; attempt += 1)); do
    if ! status="$(curl -ksS -o "$response_file" -w '%{http_code}' "$PUBLIC_BASE_URL/ready")"; then
      status=000
    fi
    if [[ $status == 200 ]]; then
      rm -f "$response_file"
      printf '[phase4-real-stack] readiness converged after %s attempt(s)\n' "$attempt"
      return 0
    fi
    sleep 2
  done

  printf '[phase4-real-stack] readiness did not converge (status=%s): ' "$status" >&2
  cat "$response_file" >&2 || true
  printf '\n' >&2
  rm -f "$response_file"
  return 1
}

assert_real_stack_sources() {
  local scan_status
  if grep -R -nE --include='*.ts' '(^|[^[:alnum:]_])(page|context)\.route[[:space:]]*\(' \
    "$ROOT_DIR/apps/web/e2e/real-stack"; then
    printf '%s\n' 'Real-stack Playwright specs must not intercept routes.' >&2
    return 1
  else
    scan_status=$?
    if [[ $scan_status -ne 1 ]]; then
      printf 'Real-stack route-mock scan failed with status %s.\n' "$scan_status" >&2
      return "$scan_status"
    fi
  fi
}

cleanup() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    compose ps >&2 || true
    compose logs --tail=160 api web worker keycloak seed-demo migrate >&2 || true
  fi
  if [[ "${PHASE4_KEEP_COMPOSE:-false}" != "true" ]]; then
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ -n "$DOCKER_CONFIG_TEMP" ]]; then
    rm -rf "$DOCKER_CONFIG_TEMP"
  fi
  return "$exit_code"
}

trap cleanup EXIT

cd "$ROOT_DIR"
assert_real_stack_sources
git_sha="$(git rev-parse --verify 'HEAD^{commit}')"
if [[ ! $git_sha =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Could not resolve a full source commit SHA.\n' >&2
  exit 1
fi
source_tree=clean
if [[ -n "$(git status --porcelain=v2 --untracked-files=all)" ]]; then
  source_tree=dirty
fi
sha_directory="$git_sha"
if [[ $source_tree == dirty ]]; then
  sha_directory="${git_sha}-dirty"
fi
evidence_root="${CAREOS_EVIDENCE_ROOT:-$ROOT_DIR/.tmp/release-evidence}"
evidence_dir="$evidence_root/browser/$sha_directory/phase4-real-stack"
mkdir -p "$evidence_dir"
chmod 0700 "$evidence_dir"
node - "$evidence_dir/run-metadata.json" "$git_sha" "$source_tree" <<'NODE'
const { writeFileSync } = require('node:fs');
const [path, gitSha, sourceTree] = process.argv.slice(2);
writeFileSync(
  path,
  `${JSON.stringify({ checkId: 'EVAL-RC-007', generatedAt: new Date().toISOString(), gitSha, sourceTree }, null, 2)}\n`,
  'utf8',
);
NODE
rm -rf apps/web/e2e/test-results/phase4-real-stack \
  apps/web/e2e/test-results/phase4-real-stack.json

compose config --quiet
compose build api web worker hermes keycloak
compose up --wait --wait-timeout 900 -d keycloak || {
  compose ps >&2 || true
  compose logs --tail=200 postgres keycloak >&2 || true
  exit 1
}
compose up --wait --wait-timeout 900 -d caddy worker docling-serve gotenberg || {
  compose ps >&2 || true
  compose logs --tail=200 >&2 || true
  exit 1
}

wait_for_readiness

PLAYWRIGHT_BASE_URL="$PUBLIC_BASE_URL" \
  pnpm --filter @careos/e2e test:real
node scripts/check-playwright-evidence.mjs \
  apps/web/e2e/test-results/phase4-real-stack.json \
  --tests-per-project 3 \
  chromium-real-stack \
  mobile-chromium-real-stack \
  | tee "$evidence_dir/playwright-summary.json"
cp apps/web/e2e/test-results/phase4-real-stack.json "$evidence_dir/playwright-report.json"
node - "$evidence_dir" <<'NODE'
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const directory = process.argv[2];
const files = ['playwright-report.json', 'playwright-summary.json'].map((name) => ({
  name,
  sha256: createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'),
}));
writeFileSync(
  join(directory, 'evidence-manifest.json'),
  `${JSON.stringify({ files, generatedAt: new Date().toISOString(), status: 'passed' }, null, 2)}\n`,
  'utf8',
);
NODE

printf '[phase4-real-stack] passed against %s (project=%s, source tree=%s)\n' \
  "$PUBLIC_BASE_URL" "$PROJECT_NAME" "$source_tree"
printf '[phase4-real-stack] evidence: %s\n' "$evidence_dir"
