import { type RotaAnalysisResult, type RotaAnalyzeWorkflowInput } from '@careos/contracts/workflow';
import { proxyActivities } from '@temporalio/workflow';

import type * as rotaActivities from '../activities/rota.js';

const { loadRotaContext, analyzeRota, narrateRotaAnalysis } = proxyActivities<
  typeof rotaActivities
>({
  retry: { initialInterval: '1 second', maximumAttempts: 3 },
  startToCloseTimeout: '30 seconds',
});

export async function RotaAnalyzeWorkflow(
  input: RotaAnalyzeWorkflowInput,
): Promise<RotaAnalysisResult> {
  const context = await loadRotaContext({
    actor: input.actor,
    homeId: input.homeId,
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    tenantId: input.tenantId,
  });

  const analysis = await analyzeRota({
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    rules: context.rules,
    shifts: context.shifts,
    staff: context.staff,
  });

  const narration = await narrateRotaAnalysis({
    ...(input.actor.agentRunId !== undefined ? { agentRunId: input.actor.agentRunId } : {}),
    correlationId: input.correlationId,
    gaps: analysis.gaps,
    homeId: input.homeId,
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    proposals: analysis.proposals,
    shifts: context.shifts,
    tenantId: input.tenantId,
  });

  return {
    correlationId: input.correlationId,
    gaps: analysis.gaps,
    narration: narration.refused ? '' : narration.narration,
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    proposals: analysis.proposals,
    shifts: context.shifts,
  };
}
