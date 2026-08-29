import type { HandoverActor, HandoverWorkflowInput } from '@careos/contracts';
import { handoverWorkflowId } from '@careos/contracts';
import type { ActivityContext } from '@microsoft/durabletask-js';

import {
  persistHandover,
  summarizeHandover,
  validateHandover,
} from '../../activities/handovers.js';
import { dispatchHandoverNotifications } from '../../activities/novu.js';
import { withTenantContext } from '../../db/pg.js';
import type {
  DurableHandoverResult,
  FinalizeHandoverFailureInput,
  HandoverOrchestratorInput,
} from '../handover.contracts.js';

interface HandoverCommandRow {
  readonly failure_reason: string | null;
  readonly payload: unknown;
  readonly status: 'pending' | 'processing' | 'applied' | 'failed';
}

export async function processHandoverCommandActivity(
  _context: ActivityContext,
  input: HandoverOrchestratorInput,
): Promise<DurableHandoverResult> {
  const command = await loadCommand(input);
  if (command.status === 'applied') return loadCompletedResult(input);
  if (command.status === 'failed') {
    return failedResult(
      input.handoverId,
      command.failure_reason?.startsWith('handover-validation-failed') === true
        ? 'validation-failed'
        : 'processing-failed',
    );
  }

  await markCommandProcessing(input);
  try {
    const payload = parseHandoverPayload(command.payload, input);
    const summary = await summarizeHandover({
      agentRunId: undefined,
      correlationId: payload.correlationId,
      freeText: payload.freeText,
      homeId: payload.homeId,
      shiftId: payload.shiftId,
      tenantId: payload.tenantId,
      transcriptObjectKey: payload.transcriptObjectKey,
    });
    const formData = { ...summary.formData, shiftId: payload.shiftId };
    const validation = await validateHandover({ formData });
    if (!validation.valid) {
      await markTerminalOutcome(input, 'failed', 'handover-validation-failed');
      return {
        ...failedResult(input.handoverId, 'validation-failed'),
        missingMandatory: validation.missingMandatory,
      };
    }

    const actor: HandoverActor = {
      correlationId: payload.correlationId,
      kind: 'user',
      promptHash: summary.promptHash,
      userId: payload.authorUserId,
    };
    const persisted = await persistHandover({
      actor,
      authorUserId: payload.authorUserId,
      formData,
      handoverId: payload.handoverId,
      homeId: payload.homeId,
      shiftId: payload.shiftId,
      sourceText: payload.freeText,
      summary: summary.summary,
      tenantId: payload.tenantId,
      transcriptObjectKey: payload.transcriptObjectKey,
      workflowId: handoverWorkflowId(payload.handoverId),
    });
    await dispatchHandoverNotifications({
      actor,
      assigneeUserIds: persisted.assigneeUserIds,
      handoverId: payload.handoverId,
      homeId: payload.homeId,
      nextShiftId: persisted.nextShiftId,
      shiftId: payload.shiftId,
      taskIds: persisted.taskIds,
      tenantId: payload.tenantId,
    });
    await markTerminalOutcome(input, 'applied', null);
    return {
      handoverId: input.handoverId,
      missingMandatory: [],
      status: 'completed',
      taskIds: persisted.taskIds,
    };
  } catch (error) {
    try {
      await recordAttemptFailure(input, deepestErrorMessage(error));
    } catch {
      // The scheduler error remains generic even if diagnostic persistence fails.
    }
    throw new Error('Handover command processing failed.');
  }
}

export async function finalizeHandoverFailureActivity(
  _context: ActivityContext,
  input: FinalizeHandoverFailureInput,
): Promise<void> {
  try {
    await markTerminalOutcome(input, 'failed', 'handover-processing-failed');
  } catch {
    throw new Error('Handover failure finalization failed.');
  }
}

async function loadCommand(input: HandoverOrchestratorInput): Promise<HandoverCommandRow> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<HandoverCommandRow>(
        `SELECT c.payload, c.status::text AS status, c.failure_reason
           FROM core.workflow_commands c
           JOIN core.workflow_instances w ON w.id = c.workflow_instance_id
          WHERE c.id = $1::uuid
            AND c.command_type = 'handover.initialize'
            AND w.workflow_kind = 'handover'
            AND w.subject_type = 'handover'
            AND w.subject_id = $2::uuid
            AND w.runtime = 'durable'::"core"."WorkflowRuntimeKind"
          LIMIT 1`,
        [input.commandId, input.handoverId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('Handover command was not found.');
      return row;
    },
  );
}

async function loadCompletedResult(
  input: HandoverOrchestratorInput,
): Promise<DurableHandoverResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const handover = await client.query<{ readonly id: string }>(
        `SELECT id::text AS id FROM core.handover_records WHERE id = $1::uuid LIMIT 1`,
        [input.handoverId],
      );
      if (handover.rows[0] === undefined) {
        throw new Error('Applied Handover command has no persisted handover.');
      }
      const tasks = await client.query<{ readonly task_id: string }>(
        `SELECT task_id::text AS task_id
           FROM core.handover_tasks
          WHERE handover_record_id = $1::uuid
          ORDER BY created_at ASC, task_id ASC`,
        [input.handoverId],
      );
      return {
        handoverId: input.handoverId,
        missingMandatory: [],
        status: 'completed',
        taskIds: tasks.rows.map((row) => row.task_id),
      };
    },
  );
}

async function markCommandProcessing(input: HandoverOrchestratorInput): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_commands
            SET status = 'processing'::"core"."WorkflowCommandStatus",
                updated_at = now()
          WHERE id = $1::uuid
            AND status = 'pending'::"core"."WorkflowCommandStatus"`,
        [input.commandId],
      );
    },
  );
}

async function recordAttemptFailure(
  input: HandoverOrchestratorInput,
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

async function markTerminalOutcome(
  input: Pick<
    HandoverOrchestratorInput,
    'actor' | 'commandId' | 'handoverId' | 'homeId' | 'tenantId'
  >,
  commandStatus: 'applied' | 'failed',
  failureDetail: string | null,
): Promise<void> {
  await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      await client.query(
        `UPDATE core.workflow_commands
            SET status = $2::"core"."WorkflowCommandStatus",
                failure_reason = $3,
                processed_at = now(),
                updated_at = now()
          WHERE id = $1::uuid
            AND status <> 'applied'::"core"."WorkflowCommandStatus"`,
        [input.commandId, commandStatus, failureDetail],
      );
      await client.query(
        `UPDATE core.workflow_instances
            SET status = $2, updated_at = now()
          WHERE workflow_kind = 'handover'
            AND subject_type = 'handover'
            AND subject_id = $1::uuid
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"
            AND status <> 'completed'`,
        [input.handoverId, commandStatus === 'applied' ? 'completed' : 'failed'],
      );
    },
  );
}

function parseHandoverPayload(
  value: unknown,
  input: HandoverOrchestratorInput,
): HandoverWorkflowInput {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Handover command payload is invalid.');
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.handoverId !== input.handoverId ||
    payload.tenantId !== input.tenantId ||
    payload.homeId !== input.homeId ||
    payload.shiftId !== input.shiftId ||
    payload.authorUserId !== input.authorUserId ||
    payload.correlationId !== input.actor.correlationId ||
    typeof payload.freeText !== 'string' ||
    payload.freeText.length === 0 ||
    (payload.transcriptObjectKey !== undefined && typeof payload.transcriptObjectKey !== 'string')
  ) {
    throw new Error('Handover command payload is invalid.');
  }
  return {
    authorUserId: input.authorUserId,
    correlationId: input.actor.correlationId,
    freeText: payload.freeText,
    handoverId: input.handoverId,
    homeId: input.homeId,
    shiftId: input.shiftId,
    tenantId: input.tenantId,
    ...(typeof payload.transcriptObjectKey === 'string'
      ? { transcriptObjectKey: payload.transcriptObjectKey }
      : {}),
  };
}

function failedResult(
  handoverId: string,
  outcomeCode: NonNullable<DurableHandoverResult['outcomeCode']>,
): DurableHandoverResult {
  return {
    handoverId,
    missingMandatory: [],
    outcomeCode,
    status: 'failed',
    taskIds: [],
  };
}

function deepestErrorMessage(error: unknown): string {
  let current = error;
  let message = 'handover-unknown-error';
  while (current instanceof Error) {
    if (current.message !== '') message = current.message;
    current = current.cause;
  }
  return message;
}
