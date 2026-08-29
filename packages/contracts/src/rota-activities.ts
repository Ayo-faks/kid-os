import type {
  RotaActor,
  RotaAnalysisResult,
  RotaGap,
  RotaProposal,
  RotaShiftSnapshot,
} from './rota-workflow.js';

export type RotaRuleKind = 'min_staffing' | 'gender_mix' | 'qualification_flag';

export interface RotaRuleSnapshot {
  readonly id: string;
  readonly name: string;
  readonly kind: RotaRuleKind;
  readonly parameters: Record<string, unknown>;
  readonly active: boolean;
}

export interface RotaStaffSnapshot {
  readonly userId: string;
  readonly displayName: string;
  readonly gender: string | null;
  readonly qualifications: readonly string[];
  readonly roles: readonly string[];
}

export interface LoadRotaContextInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly actor: RotaActor;
}

export interface LoadRotaContextResult {
  readonly shifts: readonly RotaShiftSnapshot[];
  readonly rules: readonly RotaRuleSnapshot[];
  readonly staff: readonly RotaStaffSnapshot[];
}

export interface AnalyzeRotaInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly shifts: readonly RotaShiftSnapshot[];
  readonly rules: readonly RotaRuleSnapshot[];
  readonly staff: readonly RotaStaffSnapshot[];
}

export interface AnalyzeRotaResult {
  readonly gaps: readonly RotaGap[];
  readonly proposals: readonly RotaProposal[];
}

export interface NarrateRotaAnalysisInput {
  readonly correlationId: string;
  readonly homeId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly shifts: readonly RotaShiftSnapshot[];
  readonly gaps: readonly RotaGap[];
  readonly proposals: readonly RotaProposal[];
  readonly tenantId: string;
  readonly agentRunId?: string;
}

export interface NarrateRotaAnalysisResult {
  readonly narration: string;
  readonly promptHash: string;
  readonly refused: boolean;
}

export type AssembleRotaAnalysisInput = RotaAnalysisResult;

export interface PublishRotaInput {
  readonly publicationId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly shiftIds: readonly string[];
  readonly note?: string;
  readonly publishedByUserId: string;
  readonly workflowId: string;
  readonly actor: RotaActor;
}

export interface PublishRotaResult {
  readonly publicationId: string;
  readonly publishedAssignmentIds: readonly string[];
  readonly status: 'published' | 'failed';
}
