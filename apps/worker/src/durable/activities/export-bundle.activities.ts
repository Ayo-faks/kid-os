import type { ActivityContext } from '@microsoft/durabletask-js';

import {
  composeExportBundle,
  markExportBundleBuilding,
  markExportBundleFailed,
  markExportBundleReady,
} from '../../activities/export-bundles.js';
import { withTenantContext } from '../../db/pg.js';
import type {
  DurableExportBundleResult,
  SeriousIncidentExportOrchestratorInput,
} from '../export-bundle.contracts.js';

type ExportBundleStatus = 'pending' | 'building' | 'ready' | 'failed';

interface ExportBundleStatusRow {
  readonly status: ExportBundleStatus;
}

export async function processSeriousIncidentExportActivity(
  _context: ActivityContext,
  input: SeriousIncidentExportOrchestratorInput,
): Promise<DurableExportBundleResult> {
  let outcome: DurableExportBundleResult;
  try {
    const existing = await readBundleStatus(input);
    if (existing === 'ready' || existing === 'failed') {
      outcome = terminalResult(input.bundleId, existing);
    } else {
      await markExportBundleBuilding({
        actor: input.actor,
        bundleId: input.bundleId,
        homeId: input.homeId,
        tenantId: input.tenantId,
      });
      const building = await readBundleStatus(input);
      if (building === 'ready' || building === 'failed') {
        outcome = terminalResult(input.bundleId, building);
      } else if (building !== 'building') {
        outcome = await recordFailure(input, 'export-bundle-invalid-state');
      } else {
        outcome = await composeAndPersist(input);
      }
    }
  } catch (error) {
    try {
      outcome = await recordFailure(input, deepestErrorMessage(error));
    } catch {
      throw new Error('Export bundle failed before a safe outcome was persisted.');
    }
  }

  try {
    await markWorkflowOwner(input, outcome.status === 'ready' ? 'completed' : 'failed');
  } catch {
    throw new Error('Export bundle outcome was persisted but ownership reconciliation failed.');
  }
  return outcome;
}

async function composeAndPersist(
  input: SeriousIncidentExportOrchestratorInput,
): Promise<DurableExportBundleResult> {
  const composed = await composeExportBundle({
    actor: input.actor,
    bundleId: input.bundleId,
    homeId: input.homeId,
    incidentId: input.incidentId,
    tenantId: input.tenantId,
  });
  await markExportBundleReady({
    actor: input.actor,
    bundleId: input.bundleId,
    homeId: input.homeId,
    manifestSha256: composed.manifestSha256,
    objectKey: composed.objectKey,
    retainUntilIso: composed.retainUntilIso,
    signature: composed.signature,
    signatureAlgorithm: composed.signatureAlgorithm,
    sizeBytes: composed.sizeBytes,
    tenantId: input.tenantId,
  });
  const status = await readBundleStatus(input);
  if (status !== 'ready') {
    throw new Error('export-bundle-ready-state-not-persisted');
  }
  return { bundleId: input.bundleId, status: 'ready' };
}

async function recordFailure(
  input: SeriousIncidentExportOrchestratorInput,
  failureDetail: string,
): Promise<DurableExportBundleResult> {
  await markExportBundleFailed({
    actor: input.actor,
    bundleId: input.bundleId,
    homeId: input.homeId,
    reason: failureDetail.slice(0, 500),
    tenantId: input.tenantId,
  });
  const status = await readBundleStatus(input);
  if (status === 'ready') return { bundleId: input.bundleId, status: 'ready' };
  if (status !== 'failed') {
    throw new Error('export-bundle-failed-state-not-persisted');
  }
  return {
    bundleId: input.bundleId,
    outcomeCode: 'bundle-build-failed',
    status: 'failed',
  };
}

function terminalResult(bundleId: string, status: 'ready' | 'failed'): DurableExportBundleResult {
  return status === 'ready'
    ? { bundleId, status }
    : { bundleId, outcomeCode: 'bundle-build-failed', status };
}

function readBundleStatus(
  input: SeriousIncidentExportOrchestratorInput,
): Promise<ExportBundleStatus | null> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<ExportBundleStatusRow>(
        `SELECT status::text AS status
           FROM core.export_bundles
          WHERE id = $1::uuid
          LIMIT 1`,
        [input.bundleId],
      );
      return result.rows[0]?.status ?? null;
    },
  );
}

async function markWorkflowOwner(
  input: SeriousIncidentExportOrchestratorInput,
  status: 'completed' | 'failed',
): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_instances
            SET status = $2, updated_at = now()
          WHERE workflow_kind = 'export-bundle'
            AND subject_type = 'export_bundle'
            AND subject_id = $1::uuid
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"`,
        [input.bundleId, status],
      );
    },
  );
}

function deepestErrorMessage(error: unknown): string {
  let current = error;
  let message = 'export-bundle-unknown-error';
  while (current instanceof Error) {
    if (current.message !== '') message = current.message;
    current = current.cause;
  }
  return message;
}
