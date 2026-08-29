import type { HandoverActor, HandoverDurableWorkflowInput } from '@careos/contracts';
import {
  HANDOVER_DURABLE_VERSION,
  HANDOVER_DURABLE_WORKFLOW_TYPE,
  handoverWorkflowId,
} from '@careos/contracts';

import { assertDurableInstanceId } from './payload-policy.js';

export const HANDOVER_ORCHESTRATION_VERSION = HANDOVER_DURABLE_VERSION;
export const HANDOVER_ORCHESTRATOR = HANDOVER_DURABLE_WORKFLOW_TYPE;
export const PROCESS_HANDOVER_COMMAND_ACTIVITY = 'processHandoverCommandActivityV1';
export const FINALIZE_HANDOVER_FAILURE_ACTIVITY = 'finalizeHandoverFailureActivityV1';

export type HandoverOrchestratorInput = HandoverDurableWorkflowInput;

export interface DurableHandoverResult {
  readonly handoverId: string;
  readonly missingMandatory: readonly string[];
  readonly outcomeCode?: 'processing-failed' | 'validation-failed';
  readonly status: 'completed' | 'failed';
  readonly taskIds: readonly string[];
}

export interface FinalizeHandoverFailureInput {
  readonly actor: HandoverActor;
  readonly commandId: string;
  readonly handoverId: string;
  readonly homeId: string;
  readonly outcomeCode: 'processing-failed';
  readonly tenantId: string;
}

export function handoverInstanceId(handoverId: string): string {
  return assertDurableInstanceId(handoverWorkflowId(handoverId));
}
