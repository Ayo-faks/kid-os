import type { RotaAnalyzeDurableWorkflowInput } from '@careos/contracts';
import {
  ROTA_ANALYZE_DURABLE_VERSION,
  ROTA_ANALYZE_DURABLE_WORKFLOW_TYPE,
  rotaAnalyzeWorkflowId,
} from '@careos/contracts';

import { assertDurableInstanceId } from './payload-policy.js';

export const ROTA_ANALYZE_ORCHESTRATION_VERSION = ROTA_ANALYZE_DURABLE_VERSION;
export const ROTA_ANALYZE_ORCHESTRATOR = ROTA_ANALYZE_DURABLE_WORKFLOW_TYPE;
export const PROCESS_ROTA_ANALYZE_COMMAND_ACTIVITY = 'processRotaAnalyzeCommandActivityV1';
export const FINALIZE_ROTA_ANALYZE_FAILURE_ACTIVITY = 'finalizeRotaAnalyzeFailureActivityV1';

export type RotaAnalyzeOrchestratorInput = RotaAnalyzeDurableWorkflowInput;

export interface DurableRotaAnalyzeResult {
  readonly analysisId: string;
  readonly outcomeCode?: 'processing-failed';
  readonly status: 'completed' | 'failed';
}

export interface FinalizeRotaAnalyzeFailureInput {
  readonly actor: RotaAnalyzeDurableWorkflowInput['actor'];
  readonly analysisId: string;
  readonly commandId: string;
  readonly homeId: string;
  readonly tenantId: string;
}

export function rotaAnalyzeInstanceId(analysisId: string): string {
  return assertDurableInstanceId(rotaAnalyzeWorkflowId(analysisId));
}
