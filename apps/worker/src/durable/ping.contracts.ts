import type { PingDurableWorkflowInput } from '@careos/contracts';
import {
  PING_DURABLE_VERSION,
  PING_DURABLE_WORKFLOW_TYPE,
  pingWorkflowId,
} from '@careos/contracts';

import { assertDurableInstanceId } from './payload-policy.js';

export const PING_ORCHESTRATION_VERSION = PING_DURABLE_VERSION;
export const PING_ORCHESTRATOR = PING_DURABLE_WORKFLOW_TYPE;
export const PROCESS_PING_COMMAND_ACTIVITY = 'processPingCommandActivityV1';
export const FINALIZE_PING_FAILURE_ACTIVITY = 'finalizePingFailureActivityV1';

export type PingOrchestratorInput = PingDurableWorkflowInput;

export interface DurablePingResult {
  readonly httpStatus: number;
  readonly pingId: string;
  readonly status: 'healthy';
}

export function pingInstanceId(pingId: string): string {
  return assertDurableInstanceId(pingWorkflowId(pingId));
}
