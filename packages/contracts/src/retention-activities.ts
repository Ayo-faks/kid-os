// Phase 4 §3 — Retention sweep workflow + activity contracts.

import { type IncidentActor } from './incidents-workflow.js';

export const RETENTION_TASK_QUEUE = 'careos.retention';
export const RETENTION_SWEEP_DURABLE_WORKFLOW_TYPE = 'RetentionSweepOrchestratorV1';
export const RETENTION_SCHEDULE_DURABLE_WORKFLOW_TYPE = 'RetentionScheduleOrchestratorV1';
export const RETENTION_DURABLE_VERSION = '1.0.0';

export type RetentionRecordType = 'incident' | 'handover_record' | 'email_draft' | 'attachment';

export type RetentionAction = 'soft_delete' | 'object_delete';

export interface RetentionPolicySnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly recordType: RetentionRecordType;
  readonly retentionDays: number;
  readonly action: RetentionAction;
  readonly enabled: boolean;
}

export interface RetentionSweepWorkflowInput {
  readonly nowIso?: string;
  readonly correlationId?: string;
}

export interface RetentionSweepDurableOwner {
  readonly homeId: string;
  readonly tenantId: string;
  readonly workflowInstanceId: string;
}

export interface RetentionSweepDurableWorkflowInput {
  readonly correlationId: string;
  readonly nowIso: string;
  readonly owner?: RetentionSweepDurableOwner;
  readonly sweepId: string;
}

export interface RetentionSweepDurableResult {
  readonly policiesApplied: number;
  readonly sweepId: string;
  readonly totalAffected: number;
  readonly totalScanned: number;
}

export function retentionSweepWorkflowId(sweepId: string): string {
  return `retention-sweep-${sweepId}`;
}

export interface ListActiveRetentionPoliciesInput {
  readonly correlationId?: string;
}

export interface ListActiveRetentionPoliciesResult {
  readonly policies: readonly RetentionPolicySnapshot[];
}

export interface ApplyRetentionPolicyInput {
  readonly policy: RetentionPolicySnapshot;
  readonly nowIso: string;
  readonly actor: IncidentActor;
  readonly workflowId: string;
}

export interface ApplyRetentionPolicyResult {
  readonly scannedCount: number;
  readonly affectedCount: number;
  readonly runId: string;
}
