// Shared contract between the API Temporal client and the worker rota
// workflows. Kept dependency-free so both NestJS and Temporal worker imports
// can compile.

export const ROTA_ANALYZE_WORKFLOW_TYPE = 'RotaAnalyzeWorkflow';
export const ROTA_ANALYZE_DURABLE_WORKFLOW_TYPE = 'RotaAnalyzeOrchestratorV1';
export const ROTA_ANALYZE_DURABLE_VERSION = '1.0.0';
export const ROTA_PUBLISH_WORKFLOW_TYPE = 'RotaPublishWorkflow';
export const ROTA_PUBLISH_DURABLE_WORKFLOW_TYPE = 'RotaPublishOrchestratorV1';
export const ROTA_PUBLISH_DURABLE_VERSION = '1.0.0';

export const ROTA_QUERIES = {
  getState: 'getState',
} as const;

export type RotaPublicationStatus = 'published' | 'failed';

export interface RotaActor {
  readonly kind: 'user' | 'agent';
  readonly userId: string | null;
  readonly correlationId: string;
  readonly agentRunId?: string;
  readonly promptHash?: string;
}

export interface RotaAnalyzeWorkflowInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly correlationId: string;
  readonly requestedByUserId: string;
  readonly actor: RotaActor;
}

export interface RotaAnalyzeDurableWorkflowInput {
  readonly actor: RotaActor;
  readonly analysisId: string;
  readonly commandId: string;
  readonly homeId: string;
  readonly requestedByUserId: string;
  readonly tenantId: string;
}

export interface RotaShiftSnapshot {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly requiredRole: string;
  readonly minHeadcount: number;
  readonly assignedUserIds: readonly string[];
}

export interface RotaGap {
  readonly shiftId: string;
  readonly kind: 'min_staffing' | 'gender_mix' | 'qualification_flag';
  readonly ruleId: string | null;
  readonly ruleName: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly detail: string;
}

export interface RotaProposal {
  readonly shiftId: string;
  readonly addUserIds: readonly string[];
  readonly removeUserIds: readonly string[];
  readonly reason: string;
  readonly resolvedGapKinds: readonly RotaGap['kind'][];
}

export interface RotaAnalysisResult {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly shifts: readonly RotaShiftSnapshot[];
  readonly gaps: readonly RotaGap[];
  readonly proposals: readonly RotaProposal[];
  readonly narration: string;
  readonly correlationId: string;
}

export interface RotaPublishWorkflowInput {
  readonly publicationId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly shiftIds: readonly string[];
  readonly note?: string;
  readonly publishedByUserId: string;
  readonly correlationId: string;
  readonly actor: RotaActor;
}

export interface RotaPublishDurableWorkflowInput {
  readonly actor: RotaActor;
  readonly commandId: string;
  readonly homeId: string;
  readonly publicationId: string;
  readonly publishedByUserId: string;
  readonly shiftIds: readonly string[];
  readonly tenantId: string;
}

export interface RotaPublishStateQuery {
  readonly publicationId: string;
  readonly status: RotaPublicationStatus | 'processing';
  readonly publishedAssignmentIds: readonly string[];
}

export function rotaAnalyzeWorkflowId(workflowId: string): string {
  return `rota-analyze-${workflowId}`;
}

export function rotaPublishWorkflowId(publicationId: string): string {
  return `rota-publish-${publicationId}`;
}
