// Phase 4 §3 — Retention sweep workflow.

import type { RetentionSweepWorkflowInput } from '@careos/contracts/workflow';
import { proxyActivities, workflowInfo } from '@temporalio/workflow';

import type * as retentionActivities from '../activities/retention.js';

const { applyRetentionPolicy, listActiveRetentionPolicies } = proxyActivities<
  typeof retentionActivities
>({
  retry: { initialInterval: '5 seconds', maximumAttempts: 3 },
  startToCloseTimeout: '10 minutes',
});

export interface RetentionSweepWorkflowResult {
  readonly policiesApplied: number;
  readonly totalScanned: number;
  readonly totalAffected: number;
}

export async function RetentionSweepWorkflow(
  input: RetentionSweepWorkflowInput,
): Promise<RetentionSweepWorkflowResult> {
  const correlationId = input.correlationId ?? workflowInfo().workflowId;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const list = await listActiveRetentionPolicies({ correlationId });

  let totalScanned = 0;
  let totalAffected = 0;
  let applied = 0;

  for (const policy of list.policies) {
    const result = await applyRetentionPolicy({
      actor: { correlationId, kind: 'system', userId: null },
      nowIso,
      policy,
      workflowId: workflowInfo().workflowId,
    });
    totalScanned += result.scannedCount;
    totalAffected += result.affectedCount;
    applied += 1;
  }

  return {
    policiesApplied: applied,
    totalAffected,
    totalScanned,
  };
}
