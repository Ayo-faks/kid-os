import type {
  RetentionSweepDurableResult,
  RetentionSweepDurableWorkflowInput,
} from '@careos/contracts';
import {
  RETENTION_DURABLE_VERSION,
  RETENTION_SCHEDULE_DURABLE_WORKFLOW_TYPE,
  RETENTION_SWEEP_DURABLE_WORKFLOW_TYPE,
  retentionSweepWorkflowId,
} from '@careos/contracts';

import { assertDurableInstanceId } from './payload-policy.js';

export const RETENTION_ORCHESTRATION_VERSION = RETENTION_DURABLE_VERSION;
export const RETENTION_SWEEP_ORCHESTRATOR = RETENTION_SWEEP_DURABLE_WORKFLOW_TYPE;
export const RETENTION_SCHEDULE_ORCHESTRATOR = RETENTION_SCHEDULE_DURABLE_WORKFLOW_TYPE;
export const PROCESS_RETENTION_SWEEP_ACTIVITY = 'processRetentionSweepActivityV1';
export const FINALIZE_RETENTION_SWEEP_FAILURE_ACTIVITY = 'finalizeRetentionSweepFailureActivityV1';
export const CALCULATE_NEXT_RETENTION_FIRE_ACTIVITY = 'calculateNextRetentionFireActivityV1';
export const START_RETENTION_SWEEP_ACTIVITY = 'startRetentionSweepActivityV1';

export interface RetentionScheduleInput {
  readonly hourLocal?: number;
  readonly timeZone?: string;
}

export interface StartRetentionSweepInput {
  readonly correlationId: string;
  readonly nowIso: string;
  readonly sweepId: string;
  readonly sweepInstanceId: string;
}

export interface CalculateNextRetentionFireInput {
  readonly afterIso: string;
  readonly hourLocal: number;
  readonly timeZone: string;
}

export type RetentionSweepOrchestratorInput = RetentionSweepDurableWorkflowInput;
export type DurableRetentionSweepResult = RetentionSweepDurableResult;

export function retentionSweepInstanceId(sweepId: string): string {
  return assertDurableInstanceId(retentionSweepWorkflowId(sweepId));
}
