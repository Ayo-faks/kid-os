// Phase 4 §2 — Serious incident export bundle workflow.

import type { SeriousIncidentExportWorkflowInput } from '@careos/contracts/workflow';
import { proxyActivities } from '@temporalio/workflow';

import type * as exportBundleActivities from '../activities/export-bundles.js';

const {
  composeExportBundle,
  markExportBundleBuilding,
  markExportBundleFailed,
  markExportBundleReady,
} = proxyActivities<typeof exportBundleActivities>({
  retry: { initialInterval: '2 seconds', maximumAttempts: 3 },
  startToCloseTimeout: '5 minutes',
});

export interface SeriousIncidentExportWorkflowResult {
  readonly status: 'ready' | 'failed';
  readonly objectKey?: string;
  readonly manifestSha256?: string;
}

export async function SeriousIncidentExportWorkflow(
  input: SeriousIncidentExportWorkflowInput,
): Promise<SeriousIncidentExportWorkflowResult> {
  try {
    await markExportBundleBuilding({
      actor: input.actor,
      bundleId: input.bundleId,
      homeId: input.homeId,
      tenantId: input.tenantId,
    });

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

    return {
      manifestSha256: composed.manifestSha256,
      objectKey: composed.objectKey,
      status: 'ready',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'export-bundle-unknown-error';
    await markExportBundleFailed({
      actor: input.actor,
      bundleId: input.bundleId,
      homeId: input.homeId,
      reason: reason.slice(0, 500),
      tenantId: input.tenantId,
    });
    return { status: 'failed' };
  }
}
