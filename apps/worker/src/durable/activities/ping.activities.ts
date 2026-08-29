import type { ActivityContext } from '@microsoft/durabletask-js';

import { helloHermes } from '../../activities/hermes.js';
import { withSystemContext } from '../../db/pg.js';
import type { DurablePingResult, PingOrchestratorInput } from '../ping.contracts.js';

interface PingCommandRow {
  readonly payload: unknown;
  readonly result: unknown;
  readonly status: 'pending' | 'processing' | 'applied' | 'failed';
}

export async function processPingCommandActivity(
  _context: ActivityContext,
  input: PingOrchestratorInput,
): Promise<DurablePingResult> {
  const command = await loadCommand(input);
  if (command.status === 'applied') return parsePingResult(command.result, input.pingId);
  if (command.status === 'failed') throw new Error('Ping command processing failed.');

  await updateCommand(input, 'processing');
  try {
    const message = parsePingMessage(command.payload);
    const hermes = await helloHermes({ message });
    const result: DurablePingResult = {
      httpStatus: hermes.status,
      pingId: input.pingId,
      status: 'healthy',
    };
    await withSystemContext({ correlationId: input.correlationId }, async (client) => {
      await client.query(
        `UPDATE core.system_workflow_commands
            SET status = 'applied'::"core"."WorkflowCommandStatus",
                result = $2::jsonb,
                failure_reason = NULL,
                processed_at = now(),
                updated_at = now()
          WHERE id = $1::uuid`,
        [input.commandId, JSON.stringify(result)],
      );
      await client.query(
        `UPDATE core.system_workflow_instances
            SET status = 'completed', updated_at = now()
          WHERE workflow_kind = 'ping'
            AND instance_id = $1
            AND runtime = 'durable'::"core"."WorkflowRuntimeKind"`,
        [`phase0-ping-${input.pingId}`],
      );
    });
    return result;
  } catch {
    throw new Error('Ping command processing failed.');
  }
}

export async function finalizePingFailureActivity(
  _context: ActivityContext,
  input: PingOrchestratorInput,
): Promise<void> {
  try {
    await withSystemContext({ correlationId: input.correlationId }, async (client) => {
      await client.query(
        `UPDATE core.system_workflow_commands
            SET status = 'failed'::"core"."WorkflowCommandStatus",
                result = NULL,
                failure_reason = 'ping-processing-failed',
                processed_at = now(),
                updated_at = now()
          WHERE id = $1::uuid
            AND status <> 'applied'::"core"."WorkflowCommandStatus"`,
        [input.commandId],
      );
      await client.query(
        `UPDATE core.system_workflow_instances
            SET status = 'failed', updated_at = now()
          WHERE workflow_kind = 'ping'
            AND instance_id = $1
            AND status <> 'completed'`,
        [`phase0-ping-${input.pingId}`],
      );
    });
  } catch {
    throw new Error('Ping failure finalization failed.');
  }
}

async function loadCommand(input: PingOrchestratorInput): Promise<PingCommandRow> {
  return withSystemContext({ correlationId: input.correlationId }, async (client) => {
    const result = await client.query<PingCommandRow>(
      `SELECT c.payload, c.result, c.status::text AS status
         FROM core.system_workflow_commands c
         JOIN core.system_workflow_instances w ON w.id = c.workflow_instance_id
        WHERE c.id = $1::uuid
          AND c.command_type = 'ping.initialize'
          AND w.workflow_kind = 'ping'
          AND w.instance_id = $2
          AND w.runtime = 'durable'::"core"."WorkflowRuntimeKind"
        LIMIT 1`,
      [input.commandId, `phase0-ping-${input.pingId}`],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Ping command was not found.');
    return row;
  });
}

async function updateCommand(input: PingOrchestratorInput, status: 'processing'): Promise<void> {
  await withSystemContext({ correlationId: input.correlationId }, async (client) => {
    await client.query(
      `UPDATE core.system_workflow_commands
          SET status = $2::"core"."WorkflowCommandStatus", updated_at = now()
        WHERE id = $1::uuid
          AND status = 'pending'::"core"."WorkflowCommandStatus"`,
      [input.commandId, status],
    );
  });
}

function parsePingMessage(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new Error('Ping payload is invalid.');
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).some((key) => key !== 'message') ||
    typeof payload.message !== 'string' ||
    payload.message.length === 0 ||
    payload.message.length > 2_000
  ) {
    throw new Error('Ping payload is invalid.');
  }
  return payload.message;
}

function parsePingResult(value: unknown, pingId: string): DurablePingResult {
  if (typeof value !== 'object' || value === null) throw new Error('Ping result is invalid.');
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !['httpStatus', 'pingId', 'status'].includes(key)) ||
    result.pingId !== pingId ||
    result.status !== 'healthy' ||
    typeof result.httpStatus !== 'number' ||
    !Number.isInteger(result.httpStatus)
  ) {
    throw new Error('Ping result is invalid.');
  }
  return { httpStatus: result.httpStatus, pingId, status: 'healthy' };
}
