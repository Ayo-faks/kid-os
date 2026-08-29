import {
  RetryPolicy,
  type OrchestrationContext,
  type Task,
  type TOrchestrator,
} from '@microsoft/durabletask-js';

import { assertDurablePayload } from '../payload-policy.js';
import {
  type DurablePingResult,
  FINALIZE_PING_FAILURE_ACTIVITY,
  PING_ORCHESTRATION_VERSION,
  type PingOrchestratorInput,
  PROCESS_PING_COMMAND_ACTIVITY,
} from '../ping.contracts.js';

const RETRY = new RetryPolicy({ firstRetryIntervalInMilliseconds: 1_000, maxNumberOfAttempts: 3 });

// eslint-disable-next-line @typescript-eslint/require-await -- Durable Task 0.3.0 executes only async iterators.
async function* pingOrchestrator(
  context: OrchestrationContext,
  input: PingOrchestratorInput,
): AsyncGenerator<Task<unknown>, DurablePingResult, unknown> {
  assertDurablePayload(input, 'ping');
  const parsedInput = parseInput(input);
  try {
    const processed = yield context.callActivity<PingOrchestratorInput, DurablePingResult>(
      PROCESS_PING_COMMAND_ACTIVITY,
      parsedInput,
      { retry: RETRY, version: PING_ORCHESTRATION_VERSION },
    );
    const result = parseResult(processed, parsedInput.pingId);
    context.setCustomStatus(result);
    return result;
  } catch {
    yield context.callActivity<PingOrchestratorInput, void>(
      FINALIZE_PING_FAILURE_ACTIVITY,
      parsedInput,
      { retry: RETRY, version: PING_ORCHESTRATION_VERSION },
    );
    throw new Error('Ping failed.');
  }
}

export const PingOrchestrator = pingOrchestrator as unknown as TOrchestrator;

function parseInput(value: PingOrchestratorInput): PingOrchestratorInput {
  const input = value as unknown as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['commandId', 'correlationId', 'pingId'].includes(key)) ||
    typeof input.commandId !== 'string' ||
    typeof input.correlationId !== 'string' ||
    typeof input.pingId !== 'string'
  ) {
    throw new Error('Ping input is invalid.');
  }
  return {
    commandId: input.commandId,
    correlationId: input.correlationId,
    pingId: input.pingId,
  };
}

function parseResult(value: unknown, pingId: string): DurablePingResult {
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
  const parsed: DurablePingResult = {
    httpStatus: result.httpStatus,
    pingId,
    status: 'healthy',
  };
  assertDurablePayload(parsed, 'pingResult');
  return parsed;
}
