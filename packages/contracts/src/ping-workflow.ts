export const PING_DURABLE_WORKFLOW_TYPE = 'PingOrchestratorV1';
export const PING_DURABLE_VERSION = '1.0.0';

export interface PingDurableWorkflowInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly pingId: string;
}

export function pingWorkflowId(pingId: string): string {
  return `phase0-ping-${pingId}`;
}
