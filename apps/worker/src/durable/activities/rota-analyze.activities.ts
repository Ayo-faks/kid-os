import type { RotaAnalysisResult, RotaAnalyzeWorkflowInput } from '@careos/contracts';
import type { ActivityContext } from '@microsoft/durabletask-js';

import { analyzeRota, loadRotaContext, narrateRotaAnalysis } from '../../activities/rota.js';
import { withTenantContext } from '../../db/pg.js';
import type {
  DurableRotaAnalyzeResult,
  FinalizeRotaAnalyzeFailureInput,
  RotaAnalyzeOrchestratorInput,
} from '../rota-analyze.contracts.js';

interface RotaAnalyzeCommandRow {
  readonly payload: unknown;
  readonly status: 'pending' | 'processing' | 'applied' | 'failed';
}

interface AnalysisStatusRow {
  readonly status: 'processing' | 'completed' | 'failed';
}

export async function processRotaAnalyzeCommandActivity(
  _context: ActivityContext,
  input: RotaAnalyzeOrchestratorInput,
): Promise<DurableRotaAnalyzeResult> {
  const command = await loadCommand(input);
  if (command.status === 'applied') return loadTerminalResult(input);
  if (command.status === 'failed') return failedResult(input.analysisId);

  await markCommandProcessing(input);
  try {
    const payload = parseRotaAnalyzePayload(command.payload, input);
    const context = await loadRotaContext({
      actor: payload.actor,
      homeId: payload.homeId,
      periodEnd: payload.periodEnd,
      periodStart: payload.periodStart,
      tenantId: payload.tenantId,
    });
    const analysis = await analyzeRota({
      periodEnd: payload.periodEnd,
      periodStart: payload.periodStart,
      rules: context.rules,
      shifts: context.shifts,
      staff: context.staff,
    });
    const narration = await narrateRotaAnalysis({
      correlationId: payload.correlationId,
      gaps: analysis.gaps,
      homeId: payload.homeId,
      periodEnd: payload.periodEnd,
      periodStart: payload.periodStart,
      proposals: analysis.proposals,
      shifts: context.shifts,
      tenantId: payload.tenantId,
    });
    const result: RotaAnalysisResult = {
      correlationId: payload.correlationId,
      gaps: analysis.gaps,
      narration: narration.refused ? '' : narration.narration,
      periodEnd: payload.periodEnd,
      periodStart: payload.periodStart,
      proposals: analysis.proposals,
      shifts: context.shifts,
    };
    await persistCompleted(input, result);
    return { analysisId: input.analysisId, status: 'completed' };
  } catch (error) {
    try {
      await recordAttemptFailure(input, deepestErrorMessage(error));
    } catch {
      // The scheduler error remains generic even if diagnostic persistence fails.
    }
    throw new Error('Rota analysis command processing failed.');
  }
}

export async function finalizeRotaAnalyzeFailureActivity(
  _context: ActivityContext,
  input: FinalizeRotaAnalyzeFailureInput,
): Promise<void> {
  try {
    await persistFailed(input);
  } catch {
    throw new Error('Rota analysis failure finalization failed.');
  }
}

async function loadCommand(input: RotaAnalyzeOrchestratorInput): Promise<RotaAnalyzeCommandRow> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<RotaAnalyzeCommandRow>(
        `SELECT c.payload, c.status::text AS status
           FROM core.workflow_commands c
           JOIN core.workflow_instances w ON w.id = c.workflow_instance_id
          WHERE c.id = $1::uuid
            AND c.command_type = 'rota-analyze.initialize'
            AND w.workflow_kind = 'rota-analyze'
            AND w.subject_type = 'rota_analysis'
            AND w.subject_id = $2::uuid
            AND w.runtime = 'durable'::"core"."WorkflowRuntimeKind"
          LIMIT 1`,
        [input.commandId, input.analysisId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('Rota analysis command was not found.');
      return row;
    },
  );
}

async function loadTerminalResult(
  input: RotaAnalyzeOrchestratorInput,
): Promise<DurableRotaAnalyzeResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<AnalysisStatusRow>(
        `SELECT status
           FROM core.rota_analysis_results
          WHERE id = $1::uuid
          LIMIT 1`,
        [input.analysisId],
      );
      const row = result.rows[0];
      if (row?.status === 'completed') {
        return { analysisId: input.analysisId, status: 'completed' };
      }
      if (row?.status === 'failed') return failedResult(input.analysisId);
      throw new Error('Applied Rota analysis command has no terminal result.');
    },
  );
}

async function markCommandProcessing(input: RotaAnalyzeOrchestratorInput): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_commands
            SET status = 'processing'::"core"."WorkflowCommandStatus", updated_at = now()
          WHERE id = $1::uuid
            AND status = 'pending'::"core"."WorkflowCommandStatus"`,
        [input.commandId],
      );
    },
  );
}

async function recordAttemptFailure(
  input: RotaAnalyzeOrchestratorInput,
  failureDetail: string,
): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_commands
            SET failure_reason = $2, updated_at = now()
          WHERE id = $1::uuid
            AND status = 'processing'::"core"."WorkflowCommandStatus"`,
        [input.commandId, failureDetail.slice(0, 500)],
      );
    },
  );
}

async function persistCompleted(
  input: RotaAnalyzeOrchestratorInput,
  result: RotaAnalysisResult,
): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `INSERT INTO core.rota_analysis_results
           (id, tenant_id, home_id, workflow_id, correlation_id, status,
            result, failure_code, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'completed', $6::jsonb, NULL, now(), now())
         ON CONFLICT (id) DO UPDATE SET
           status = 'completed', result = EXCLUDED.result,
           failure_code = NULL, updated_at = now()`,
        [
          input.analysisId,
          input.tenantId,
          input.homeId,
          `rota-analyze-${input.analysisId}`,
          input.actor.correlationId,
          JSON.stringify(result),
        ],
      );
      await client.query(
        `UPDATE core.workflow_commands
            SET status = 'applied'::"core"."WorkflowCommandStatus",
                failure_reason = NULL, processed_at = now(), updated_at = now()
          WHERE id = $1::uuid`,
        [input.commandId],
      );
      await client.query(
        `UPDATE core.workflow_instances
            SET status = 'completed', updated_at = now()
          WHERE workflow_kind = 'rota-analyze'
            AND subject_type = 'rota_analysis'
            AND subject_id = $1::uuid
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"`,
        [input.analysisId],
      );
    },
  );
}

async function persistFailed(input: FinalizeRotaAnalyzeFailureInput): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `INSERT INTO core.rota_analysis_results
           (id, tenant_id, home_id, workflow_id, correlation_id, status,
            result, failure_code, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'failed', NULL,
                 'processing-failed', now(), now())
         ON CONFLICT (id) DO UPDATE SET
           status = 'failed', result = NULL,
           failure_code = 'processing-failed', updated_at = now()
         WHERE core.rota_analysis_results.status <> 'completed'`,
        [
          input.analysisId,
          input.tenantId,
          input.homeId,
          `rota-analyze-${input.analysisId}`,
          input.actor.correlationId,
        ],
      );
      await client.query(
        `UPDATE core.workflow_commands
            SET status = 'failed'::"core"."WorkflowCommandStatus",
                failure_reason = COALESCE(failure_reason, 'rota-analysis-processing-failed'),
                processed_at = now(), updated_at = now()
          WHERE id = $1::uuid
            AND status <> 'applied'::"core"."WorkflowCommandStatus"`,
        [input.commandId],
      );
      await client.query(
        `UPDATE core.workflow_instances
            SET status = 'failed', updated_at = now()
          WHERE workflow_kind = 'rota-analyze'
            AND subject_type = 'rota_analysis'
            AND subject_id = $1::uuid
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"
            AND status <> 'completed'`,
        [input.analysisId],
      );
    },
  );
}

function parseRotaAnalyzePayload(
  value: unknown,
  input: RotaAnalyzeOrchestratorInput,
): RotaAnalyzeWorkflowInput {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Rota analysis command payload is invalid.');
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.tenantId !== input.tenantId ||
    payload.homeId !== input.homeId ||
    payload.requestedByUserId !== input.requestedByUserId ||
    payload.correlationId !== input.actor.correlationId ||
    typeof payload.periodStart !== 'string' ||
    typeof payload.periodEnd !== 'string' ||
    !isRotaActor(payload.actor)
  ) {
    throw new Error('Rota analysis command payload is invalid.');
  }
  return payload as unknown as RotaAnalyzeWorkflowInput;
}

function isRotaActor(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const actor = value as Record<string, unknown>;
  return (
    (actor.kind === 'user' || actor.kind === 'agent') &&
    (typeof actor.userId === 'string' || actor.userId === null) &&
    typeof actor.correlationId === 'string'
  );
}

function failedResult(analysisId: string): DurableRotaAnalyzeResult {
  return { analysisId, outcomeCode: 'processing-failed', status: 'failed' };
}

function deepestErrorMessage(error: unknown): string {
  let current = error;
  let message = 'rota-analysis-unknown-error';
  while (current instanceof Error) {
    if (current.message !== '') message = current.message;
    current = current.cause;
  }
  return message;
}
