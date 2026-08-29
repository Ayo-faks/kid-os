import type { RotaPublishWorkflowInput } from '@careos/contracts';
import type { ActivityContext } from '@microsoft/durabletask-js';

import { publishRota } from '../../activities/rota.js';
import { withTenantContext } from '../../db/pg.js';
import type {
  DurableRotaPublishResult,
  FinalizeRotaPublishFailureInput,
  RotaPublishOrchestratorInput,
} from '../rota-publish.contracts.js';

interface RotaCommandRow {
  readonly payload: unknown;
  readonly status: 'pending' | 'processing' | 'applied' | 'failed';
}

export async function processRotaPublishCommandActivity(
  _context: ActivityContext,
  input: RotaPublishOrchestratorInput,
): Promise<DurableRotaPublishResult> {
  const command = await loadCommand(input);
  if (command.status === 'applied') return loadPublishedResult(input);
  if (command.status === 'failed') return failedResult(input.publicationId);

  await markCommandProcessing(input);
  try {
    const payload = parseRotaPublishPayload(command.payload, input);
    const published = await publishRota({
      actor: payload.actor,
      homeId: payload.homeId,
      note: payload.note,
      periodEnd: payload.periodEnd,
      periodStart: payload.periodStart,
      publicationId: payload.publicationId,
      publishedByUserId: payload.publishedByUserId,
      shiftIds: payload.shiftIds,
      tenantId: payload.tenantId,
      workflowId: payload.publicationId,
    });
    await markTerminalOutcome(
      input,
      'applied',
      null,
      published.status === 'published' ? 'completed' : 'failed',
    );
    return {
      ...(published.status === 'failed' ? { outcomeCode: 'processing-failed' as const } : {}),
      publicationId: published.publicationId,
      publishedAssignmentIds: published.publishedAssignmentIds,
      status: published.status,
    };
  } catch (error) {
    try {
      await recordAttemptFailure(input, deepestErrorMessage(error));
    } catch {
      // The scheduler error remains generic even if diagnostic persistence fails.
    }
    throw new Error('Rota publish command processing failed.');
  }
}

export async function finalizeRotaPublishFailureActivity(
  _context: ActivityContext,
  input: FinalizeRotaPublishFailureInput,
): Promise<void> {
  try {
    await markTerminalOutcome(input, 'failed', 'rota-publish-processing-failed', 'failed');
  } catch {
    throw new Error('Rota publish failure finalization failed.');
  }
}

async function loadCommand(input: RotaPublishOrchestratorInput): Promise<RotaCommandRow> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<RotaCommandRow>(
        `SELECT c.payload, c.status::text AS status
           FROM core.workflow_commands c
           JOIN core.workflow_instances w ON w.id = c.workflow_instance_id
          WHERE c.id = $1::uuid
            AND c.command_type = 'rota-publish.initialize'
            AND w.workflow_kind = 'rota-publish'
            AND w.subject_type = 'rota_publication'
            AND w.subject_id = $2::uuid
            AND w.runtime = 'durable'::"core"."WorkflowRuntimeKind"
          LIMIT 1`,
        [input.commandId, input.publicationId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('Rota publish command was not found.');
      return row;
    },
  );
}

async function loadPublishedResult(
  input: RotaPublishOrchestratorInput,
): Promise<DurableRotaPublishResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<{
        readonly assignment_ids: string[];
        readonly id: string;
        readonly status: 'published' | 'failed';
      }>(
        `SELECT id::text AS id, assignment_ids, status::text AS status
           FROM core.rota_publications
          WHERE id = $1::uuid
          LIMIT 1`,
        [input.publicationId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('Applied Rota publish command has no publication row.');
      }
      return {
        ...(row.status === 'failed' ? { outcomeCode: 'processing-failed' as const } : {}),
        publicationId: row.id,
        publishedAssignmentIds: row.assignment_ids ?? [],
        status: row.status,
      };
    },
  );
}

async function markCommandProcessing(input: RotaPublishOrchestratorInput): Promise<void> {
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
  input: RotaPublishOrchestratorInput,
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
    RotaPublishOrchestratorInput,
    'actor' | 'commandId' | 'homeId' | 'publicationId' | 'tenantId'
  >,
  commandStatus: 'applied' | 'failed',
  failureDetail: string | null,
  ownerStatus: 'completed' | 'failed',
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
          WHERE workflow_kind = 'rota-publish'
            AND subject_type = 'rota_publication'
            AND subject_id = $1::uuid
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"
            AND status <> 'completed'`,
        [input.publicationId, ownerStatus],
      );
    },
  );
}

function parseRotaPublishPayload(
  value: unknown,
  input: RotaPublishOrchestratorInput,
): RotaPublishWorkflowInput {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Rota publish command payload is invalid.');
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.publicationId !== input.publicationId ||
    payload.tenantId !== input.tenantId ||
    payload.homeId !== input.homeId ||
    payload.publishedByUserId !== input.publishedByUserId ||
    payload.correlationId !== input.actor.correlationId ||
    typeof payload.periodStart !== 'string' ||
    typeof payload.periodEnd !== 'string' ||
    !Array.isArray(payload.shiftIds) ||
    !payload.shiftIds.every((shiftId) => typeof shiftId === 'string') ||
    (payload.note !== undefined && typeof payload.note !== 'string') ||
    !isRotaActor(payload.actor)
  ) {
    throw new Error('Rota publish command payload is invalid.');
  }
  return payload as unknown as RotaPublishWorkflowInput;
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

function failedResult(publicationId: string): DurableRotaPublishResult {
  return {
    outcomeCode: 'processing-failed',
    publicationId,
    publishedAssignmentIds: [],
    status: 'failed',
  };
}

function deepestErrorMessage(error: unknown): string {
  let current = error;
  let message = 'rota-publish-unknown-error';
  while (current instanceof Error) {
    if (current.message !== '') message = current.message;
    current = current.cause;
  }
  return message;
}
