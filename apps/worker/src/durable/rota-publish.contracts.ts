import type { RotaPublishDurableWorkflowInput } from '@careos/contracts';
import {
  ROTA_PUBLISH_DURABLE_VERSION,
  ROTA_PUBLISH_DURABLE_WORKFLOW_TYPE,
  rotaPublishWorkflowId,
} from '@careos/contracts';

import { assertDurableInstanceId } from './payload-policy.js';

export const ROTA_PUBLISH_ORCHESTRATION_VERSION = ROTA_PUBLISH_DURABLE_VERSION;
export const ROTA_PUBLISH_ORCHESTRATOR = ROTA_PUBLISH_DURABLE_WORKFLOW_TYPE;
export const PROCESS_ROTA_PUBLISH_COMMAND_ACTIVITY = 'processRotaPublishCommandActivityV1';
export const FINALIZE_ROTA_PUBLISH_FAILURE_ACTIVITY = 'finalizeRotaPublishFailureActivityV1';

export type RotaPublishOrchestratorInput = RotaPublishDurableWorkflowInput;

export interface DurableRotaPublishResult {
  readonly outcomeCode?: 'processing-failed';
  readonly publicationId: string;
  readonly publishedAssignmentIds: readonly string[];
  readonly status: 'published' | 'failed';
}

export interface FinalizeRotaPublishFailureInput {
  readonly actor: RotaPublishDurableWorkflowInput['actor'];
  readonly commandId: string;
  readonly homeId: string;
  readonly publicationId: string;
  readonly tenantId: string;
}

export function rotaPublishInstanceId(publicationId: string): string {
  return assertDurableInstanceId(rotaPublishWorkflowId(publicationId));
}
