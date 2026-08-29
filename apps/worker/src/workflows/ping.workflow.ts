import { proxyActivities } from '@temporalio/workflow';

import type * as hermesActivities from '../activities/hermes.js';
import type { HelloHermesResult } from '../activities/hermes.js';

const { helloHermes } = proxyActivities<typeof hermesActivities>({
  retry: {
    initialInterval: '1 second',
    maximumAttempts: 3,
  },
  startToCloseTimeout: '15 seconds',
});

export interface PingWorkflowInput {
  readonly message?: string;
}

export interface PingWorkflowResult {
  readonly hermes: HelloHermesResult;
  readonly message: string;
  readonly workflow: 'PingWorkflow';
}

export async function PingWorkflow(input: PingWorkflowInput = {}): Promise<PingWorkflowResult> {
  const message = input.message ?? 'hello from NestJS';
  const hermes = await helloHermes({ message });

  return {
    hermes,
    message,
    workflow: 'PingWorkflow',
  };
}
