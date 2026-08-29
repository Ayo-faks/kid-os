#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = resolve(repoRoot, 'docs/durable-parity-matrix.json');
const schemaPath = resolve(repoRoot, 'docs/durable-parity-matrix.schema.json');
const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const requiredWorkflows = new Map([
  [
    'approval-routing',
    workflow(
      'approval-routing.workflow.ts',
      'approval-routing.orchestrator.ts',
      'approval-routing.emulator.integration.test.ts',
      ['early-event-buffering', 'dual-sign-off', 'late-event-drop', 'persisted-owner-routing'],
    ),
  ],
  [
    'document-ingest',
    workflow(
      'doc-ingest.workflow.ts',
      'document-ingest.orchestrator.ts',
      'document-ingest.emulator.integration.test.ts',
      ['id-only-input', 'terminal-persistence', 'failure-finalization'],
    ),
  ],
  [
    'email-draft',
    workflow(
      'email-draft.workflow.ts',
      'email-draft.orchestrator.ts',
      'email-draft.emulator.integration.test.ts',
      ['routine-draft', 'prepared-draft', 'validation-failure', 'approval-routing'],
    ),
  ],
  [
    'export-bundle',
    workflow(
      'serious-incident-export.workflow.ts',
      'export-bundle.orchestrator.ts',
      'export-bundle.emulator.integration.test.ts',
      ['id-only-input', 'ready', 'failure-finalization', 'object-reconciliation'],
    ),
  ],
  [
    'handover',
    workflow(
      'handover.workflow.ts',
      'handover.orchestrator.ts',
      'handover.emulator.integration.test.ts',
      ['id-only-command', 'completed', 'failure-finalization'],
    ),
  ],
  [
    'handover-due-reminder',
    workflow(
      'handover-due-reminder.workflow.ts',
      'handover-due-reminder.orchestrators.ts',
      'handover-due-reminder.emulator.integration.test.ts',
      ['singleton-schedule', 'sweep', 'detached-delivery', 'idempotent-delivery'],
    ),
  ],
  [
    'incident-follow-up',
    workflow(
      'incident-follow-up-action.workflow.ts',
      'incident-follow-up.orchestrator.ts',
      'incident-follow-up.emulator.integration.test.ts',
      ['export-follow-up', 'safeguarding-email', 'needs-configuration', 'failure-finalization'],
    ),
  ],
  [
    'incident-report',
    workflow(
      'incident-report.workflow.ts',
      'incident-report.orchestrator.ts',
      'incident-report.emulator.integration.test.ts',
      [
        'draft',
        'missing-fields',
        'approval-child',
        'human-veto',
        'export',
        'persisted-owner-routing',
      ],
    ),
  ],
  [
    'missing-fields-audit',
    workflow(
      'missing-fields-audit.workflow.ts',
      'missing-fields-audit.orchestrators.ts',
      'missing-fields-audit.emulator.integration.test.ts',
      ['singleton-schedule', 'sweep', 'no-missing-fields', 'detached-delivery'],
    ),
  ],
  [
    'ping',
    workflow('ping.workflow.ts', 'ping.orchestrator.ts', 'ping.emulator.integration.test.ts', [
      'opaque-command',
      'operational-status-only',
      'failure-finalization',
    ]),
  ],
  [
    'retention',
    workflow(
      'retention-sweep.workflow.ts',
      'retention.orchestrators.ts',
      'retention.emulator.integration.test.ts',
      ['singleton-schedule', 'aggregate-only-sweep', 'object-delete', 'failure-finalization'],
    ),
  ],
  [
    'rota-analyze',
    workflow(
      'rota-analyze.workflow.ts',
      'rota-analyze.orchestrator.ts',
      'rota-analyze.emulator.integration.test.ts',
      ['id-only-input', 'result-persistence', 'malformed-result-rejection', 'failure-finalization'],
    ),
  ],
  [
    'rota-publish',
    workflow(
      'rota-publish.workflow.ts',
      'rota-publish.orchestrator.ts',
      'rota-publish.emulator.integration.test.ts',
      ['id-only-command', 'publication-persistence', 'failure-finalization'],
    ),
  ],
  [
    'safeguarding-digest',
    workflow(
      'safeguarding-digest.workflow.ts',
      'safeguarding-digest.orchestrators.ts',
      'safeguarding-digest.emulator.integration.test.ts',
      ['singleton-schedule', 'aggregate-only-sweep', 'detached-delivery', 'audit-idempotency'],
    ),
  ],
  [
    'shift-reminder',
    workflow(
      'shift-reminder.workflow.ts',
      'shift-reminder.orchestrators.ts',
      'shift-reminder.emulator.integration.test.ts',
      ['singleton-schedule', 'eternal-timer', 'sweep', 'detached-delivery', 'termination'],
    ),
  ],
]);
const requiredSuites = new Map([
  [
    'recovery',
    suite('recovery.emulator.integration.test.ts', [
      'worker-restart',
      'side-effect-reconciliation',
      'database-retry',
      'cancellation',
      'suspend-resume',
      'termination',
    ]),
  ],
  [
    'side-effects',
    suite('side-effects.emulator.integration.test.ts', ['idempotent-or-reconcilable-effects']),
  ],
  [
    'tenant-idempotency',
    suite('tenant-idempotency.emulator.integration.test.ts', [
      'duplicate-start',
      'duplicate-event',
      'tenant-isolation',
    ]),
  ],
  [
    'versioning',
    suite('versioning.emulator.integration.test.ts', [
      'v1-in-flight',
      'v2-new-start',
      'retirement-block',
    ]),
  ],
]);

if (matrix.$schema !== './durable-parity-matrix.schema.json') {
  throw new Error('parity matrix must reference its committed JSON Schema');
}
if (schema.$id !== './durable-parity-matrix.schema.json') {
  throw new Error('parity matrix schema has an unexpected $id');
}
if (matrix.schemaVersion !== 1) throw new Error('parity matrix schemaVersion must be 1');
if (matrix.status !== 'pending-managed-staging') {
  throw new Error('parity matrix cannot pass before same-SHA managed staging evidence exists');
}
if (!Array.isArray(matrix.workflows) || matrix.workflows.length !== requiredWorkflows.size) {
  throw new Error('parity matrix must contain exactly 15 workflow families');
}
if (
  !Array.isArray(matrix.crossCuttingSuites) ||
  matrix.crossCuttingSuites.length !== requiredSuites.size
) {
  throw new Error('parity matrix must contain exactly four cross-cutting suites');
}

const workflowIds = new Set();
for (const actual of matrix.workflows) {
  const expected = requiredWorkflows.get(actual.id);
  if (expected === undefined || workflowIds.has(actual.id)) {
    throw new Error(`unknown or duplicate workflow: ${String(actual.id)}`);
  }
  workflowIds.add(actual.id);
  for (const field of ['temporal', 'durable', 'emulatorTest']) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${actual.id}.${field} differs from the approved source path`);
    }
    await requireFile(actual[field], `${actual.id}.${field}`);
  }
  requireExactBranches(actual.branches, expected.branches, actual.id);
  if (actual.managedEvidence !== null) {
    throw new Error(`${actual.id} cannot claim managed evidence before staging execution`);
  }
}

const suiteIds = new Set();
for (const actual of matrix.crossCuttingSuites) {
  const expected = requiredSuites.get(actual.id);
  if (expected === undefined || suiteIds.has(actual.id)) {
    throw new Error(`unknown or duplicate cross-cutting suite: ${String(actual.id)}`);
  }
  suiteIds.add(actual.id);
  if (actual.test !== expected.test) {
    throw new Error(`${actual.id}.test differs from the approved source path`);
  }
  await requireFile(actual.test, `${actual.id}.test`);
  requireExactBranches(actual.branches, expected.branches, actual.id);
}

process.stdout.write(
  `[durable-parity-matrix] valid workflows=${workflowIds.size} suites=${suiteIds.size} status=${matrix.status}\n`,
);

function workflow(temporalName, durableName, emulatorName, branches) {
  return {
    temporal: `apps/worker/src/workflows/${temporalName}`,
    durable: `apps/worker/src/durable/orchestrators/${durableName}`,
    emulatorTest: `apps/worker/src/durable/${emulatorName}`,
    branches,
  };
}

function suite(testName, branches) {
  return { test: `apps/worker/src/durable/${testName}`, branches };
}

function requireExactBranches(actual, expected, label) {
  if (!Array.isArray(actual) || !sameMembers(new Set(actual), new Set(expected))) {
    throw new Error(`${label} branch inventory differs from the approved matrix`);
  }
  if (actual.length !== new Set(actual).size || actual.some((branch) => !nonEmptyString(branch))) {
    throw new Error(`${label} branch inventory contains an empty or duplicate value`);
  }
}

async function requireFile(path, field) {
  if (typeof path !== 'string' || !path.startsWith('apps/worker/src/')) {
    throw new Error(`${field} must be a worker source path`);
  }
  await access(resolve(repoRoot, path));
}

function sameMembers(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}
