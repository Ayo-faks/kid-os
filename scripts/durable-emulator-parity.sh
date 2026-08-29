#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/infra/compose/docker-compose.yml"
grpc_port="${DTS_EMULATOR_GRPC_PORT:-8080}"
connection_string="Endpoint=http://127.0.0.1:${grpc_port};Authentication=None;TaskHub=default"

all_workflows=(
  approval-routing
  document-ingest
  email-draft
  export-bundle
  handover
  handover-due-reminder
  incident-follow-up
  incident-report
  missing-fields-audit
  ping
  retention
  rota-analyze
  rota-publish
  safeguarding-digest
  shift-reminder
)

usage() {
  cat <<'USAGE'
Usage:
  scripts/durable-emulator-parity.sh --all
  scripts/durable-emulator-parity.sh --workflow <name>
  scripts/durable-emulator-parity.sh --suite <name>
  scripts/durable-emulator-parity.sh --list

All evidence suites include dedicated emulator or migrated-Postgres coverage.
USAGE
}

workflow_test_file() {
  case "$1" in
    approval-routing) printf '%s\n' 'src/durable/approval-routing.emulator.integration.test.ts' ;;
    document-ingest) printf '%s\n' 'src/durable/document-ingest.emulator.integration.test.ts' ;;
    email-draft) printf '%s\n' 'src/durable/email-draft.emulator.integration.test.ts' ;;
    export-bundle) printf '%s\n' 'src/durable/export-bundle.emulator.integration.test.ts' ;;
    handover) printf '%s\n' 'src/durable/handover.emulator.integration.test.ts' ;;
    handover-due-reminder) printf '%s\n' 'src/durable/handover-due-reminder.emulator.integration.test.ts' ;;
    incident-follow-up) printf '%s\n' 'src/durable/incident-follow-up.emulator.integration.test.ts' ;;
    incident-report) printf '%s\n' 'src/durable/incident-report.emulator.integration.test.ts' ;;
    missing-fields-audit) printf '%s\n' 'src/durable/missing-fields-audit.emulator.integration.test.ts' ;;
    ping) printf '%s\n' 'src/durable/ping.emulator.integration.test.ts' ;;
    retention) printf '%s\n' 'src/durable/retention.emulator.integration.test.ts' ;;
    rota-analyze) printf '%s\n' 'src/durable/rota-analyze.emulator.integration.test.ts' ;;
    rota-publish) printf '%s\n' 'src/durable/rota-publish.emulator.integration.test.ts' ;;
    safeguarding-digest) printf '%s\n' 'src/durable/safeguarding-digest.emulator.integration.test.ts' ;;
    shift-reminder) printf '%s\n' 'src/durable/shift-reminder.emulator.integration.test.ts' ;;
    *) return 1 ;;
  esac
}

suite_test_files() {
  case "$1" in
    side-effects)
      printf '%s\n' \
        'src/durable/side-effects.emulator.integration.test.ts' \
        'src/durable/activities/approval-routing.activities.test.ts' \
        'src/durable/activities/document-ingest.activities.test.ts' \
        'src/durable/activities/email-draft.activities.test.ts' \
        'src/durable/activities/export-bundle.activities.test.ts' \
        'src/durable/activities/handover-due-reminder.activities.test.ts' \
        'src/durable/activities/handover.activities.test.ts' \
        'src/durable/activities/incident-follow-up.activities.test.ts' \
        'src/durable/activities/incident-report.activities.test.ts' \
        'src/durable/activities/missing-fields-audit.activities.test.ts' \
        'src/durable/activities/ping.activities.test.ts' \
        'src/durable/activities/retention.activities.test.ts' \
        'src/durable/activities/rota-analyze.activities.test.ts' \
        'src/durable/activities/rota-publish.activities.test.ts' \
        'src/durable/activities/safeguarding-digest.activities.test.ts' \
        'src/durable/activities/shift-reminder.activities.test.ts' \
        'src/activities/documents-extract.test.ts' \
        'src/activities/export-bundles.test.ts' \
        'src/activities/export-pdf.test.ts' \
        'src/activities/hermes.test.ts' \
        'src/activities/mattermost.test.ts' \
        'src/comms/mattermost-provider.test.ts'
      ;;
    tenant-idempotency)
      printf '%s\n' \
        'src/durable/tenant-idempotency.emulator.integration.test.ts' \
        'src/durable/approval-routing.test.ts' \
        'src/durable/activities/approval-routing.activities.test.ts' \
        'src/durable/worker.test.ts'
      ;;
    recovery) printf '%s\n' 'src/durable/recovery.emulator.integration.test.ts' ;;
    versioning)
      printf '%s\n' \
        'src/durable/versioning.emulator.integration.test.ts' \
        'src/durable/version-retirement.test.ts' \
        'src/durable/worker.test.ts'
      ;;
    *) return 1 ;;
  esac
}

append_suite_test_files() {
  local suite="$1"
  while IFS= read -r test_file; do
    test_files+=("$test_file")
  done < <(suite_test_files "$suite")
}

test_files=()
scope='all workflows'
run_side_effect_sql_contracts=false
run_tenant_idempotency_contracts=false

if [[ $# -eq 0 || ( $# -eq 1 && $1 == '--all' ) ]]; then
  for workflow in "${all_workflows[@]}"; do
    test_files+=("$(workflow_test_file "$workflow")")
  done
  append_suite_test_files side-effects
  append_suite_test_files recovery
  append_suite_test_files tenant-idempotency
  append_suite_test_files versioning
  run_side_effect_sql_contracts=true
  run_tenant_idempotency_contracts=true
  scope='all workflows and implemented suites'
elif [[ $# -eq 1 && $1 == '--list' ]]; then
  printf '%s\n' 'Workflows:'
  printf '  %s\n' "${all_workflows[@]}"
  printf '%s\n' 'Suites:'
  printf '  %s\n' recovery side-effects tenant-idempotency versioning
  exit 0
elif [[ $# -eq 2 && $1 == '--workflow' ]]; then
  if ! selected_test="$(workflow_test_file "$2")"; then
    printf 'Unknown Durable workflow: %s\n' "$2" >&2
    usage >&2
    exit 64
  fi
  test_files+=("$selected_test")
  scope="workflow $2"
elif [[ $# -eq 2 && $1 == '--suite' ]]; then
  case "$2" in
    recovery|side-effects|tenant-idempotency|versioning)
      append_suite_test_files "$2"
      if [[ $2 == 'side-effects' ]]; then
        run_side_effect_sql_contracts=true
      fi
      if [[ $2 == 'tenant-idempotency' ]]; then
        run_tenant_idempotency_contracts=true
      fi
      scope="suite $2"
      ;;
    *)
      printf 'Unknown Durable emulator suite: %s\n' "$2" >&2
      usage >&2
      exit 64
      ;;
  esac
else
  usage >&2
  exit 64
fi

if ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'DTS emulator validation requires a running Docker daemon; docker info failed.' >&2
  exit 2
fi

git_sha="$(git -C "$repo_root" rev-parse --verify 'HEAD^{commit}')"
if [[ ! $git_sha =~ ^[0-9a-f]{40}$ ]]; then
  printf 'Could not resolve a full source commit SHA.\n' >&2
  exit 1
fi
source_tree=clean
if [[ -n "$(git -C "$repo_root" status --porcelain=v2 --untracked-files=all)" ]]; then
  source_tree=dirty
fi
sha_directory="$git_sha"
if [[ $source_tree == dirty ]]; then
  sha_directory="${git_sha}-dirty"
fi
if [[ -n "${DURABLE_EVIDENCE_DIR:-}" ]]; then
  if [[ $DURABLE_EVIDENCE_DIR == /* ]]; then
    evidence_dir="$DURABLE_EVIDENCE_DIR"
  else
    evidence_dir="$repo_root/$DURABLE_EVIDENCE_DIR"
  fi
else
  evidence_root="${CAREOS_EVIDENCE_ROOT:-$repo_root/.tmp/release-evidence}"
  evidence_dir="$evidence_root/durable/$sha_directory/emulator"
fi
mkdir -p "$evidence_dir"
chmod 0700 "$evidence_dir"

node - "$evidence_dir/run-metadata.json" "$git_sha" "$source_tree" "$scope" <<'NODE'
const { writeFileSync } = require('node:fs');
const [path, gitSha, sourceTree, scope] = process.argv.slice(2);
writeFileSync(
  path,
  `${JSON.stringify({ checkId: 'DTS-030', generatedAt: new Date().toISOString(), gitSha, scope, sourceTree }, null, 2)}\n`,
  'utf8',
);
NODE

run_worker_vitest() {
  local label="$1"
  local report_path="$evidence_dir/$label.json"
  shift
  CAREOS_RUN_DURABLE_EMULATOR=true \
    CAREOS_DURABLE_EMULATOR_CONTROL=true \
    CAREOS_DURABLE_COMPOSE_FILE="$compose_file" \
    DURABLE_TASK_SCHEDULER_CONNECTION_STRING="$connection_string" \
    pnpm --dir apps/worker exec vitest run \
      "$@" \
      --no-file-parallelism \
      --reporter=json \
      --outputFile="$report_path"
  node scripts/check-vitest-evidence.mjs "$report_path" >"$evidence_dir/$label-summary.json"
}

run_api_vitest() {
  local label="$1"
  local report_path="$evidence_dir/$label.json"
  shift
  pnpm --dir apps/api exec vitest run \
    "$@" \
    --reporter=json \
    --outputFile="$report_path"
  node scripts/check-vitest-evidence.mjs "$report_path" >"$evidence_dir/$label-summary.json"
}

cleanup() {
  docker compose -f "$compose_file" --profile durable rm -sf dts-emulator >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -f "$compose_file" --profile durable up -d dts-emulator

node - "$grpc_port" <<'NODE'
const net = require('node:net');
const port = Number(process.argv[2]);
const deadline = Date.now() + 60_000;

function probe() {
  const socket = net.connect(port, '127.0.0.1');
  socket.setTimeout(1_000);
  socket.once('connect', () => {
    socket.destroy();
    process.exit(0);
  });
  const retry = () => {
    socket.destroy();
    if (Date.now() >= deadline) {
      console.error(`DTS emulator did not accept gRPC connections on ${port}.`);
      process.exit(1);
    }
    setTimeout(probe, 250);
  };
  socket.once('error', retry);
  socket.once('timeout', retry);
}

probe();
NODE

cd "$repo_root"
printf '[durable-emulator] running %s (%d test file(s))\n' "$scope" "${#test_files[@]}"
run_worker_vitest worker "${test_files[@]}"

if [[ $run_side_effect_sql_contracts == true ]]; then
  run_api_vitest api-side-effects \
    src/database/workflow-runtime-migration.test.ts \
    src/database/rota-analysis-results-migration.test.ts \
    src/database/retention-idempotency-migration.test.ts \
    src/database/safeguarding-digest-idempotency-migration.test.ts \
    src/database/system-workflow-runtime-migration.test.ts
fi

if [[ $run_tenant_idempotency_contracts == true ]]; then
  run_api_vitest api-runtime src/workflow-runtime
  CAREOS_RUN_DURABLE_TENANT_INTEGRATION=true \
    run_api_vitest api-tenant-integration \
      src/database/durable-tenant-idempotency.integration.test.ts
fi

node - "$evidence_dir" <<'NODE'
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const directory = process.argv[2];
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.json') && name !== 'run-summary.json')
  .sort()
  .map((name) => ({
    name,
    sha256: createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'),
  }));
writeFileSync(
  join(directory, 'run-summary.json'),
  `${JSON.stringify({ files, generatedAt: new Date().toISOString(), status: 'passed' }, null, 2)}\n`,
  'utf8',
);
NODE

printf '[durable-emulator] evidence: %s (source tree: %s)\n' "$evidence_dir" "$source_tree"