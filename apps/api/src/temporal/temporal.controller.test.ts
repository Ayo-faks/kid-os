import { describe, expect, it, vi } from 'vitest';

import type { PingWorkflowRuntime } from '../workflow-runtime/workflow-runtime.port.js';

import { TemporalController } from './temporal.controller.js';

describe('TemporalController', () => {
  it('starts Ping through the workflow runtime without changing the response', async () => {
    const startPingWorkflow = vi.fn<PingWorkflowRuntime['startPingWorkflow']>().mockResolvedValue({
      runId: 'run-1',
      taskQueue: 'careos.phase0',
      workflowId: 'phase0-ping-1',
    });
    const controller = new TemporalController({ startPingWorkflow });

    await expect(controller.startPing({ message: 'runtime-neutral ping' })).resolves.toEqual({
      runId: 'run-1',
      taskQueue: 'careos.phase0',
      workflowId: 'phase0-ping-1',
    });
    expect(startPingWorkflow).toHaveBeenCalledOnce();
    expect(startPingWorkflow).toHaveBeenCalledWith('runtime-neutral ping');
  });

  it('preserves the default-message path for an invalid body', async () => {
    const startPingWorkflow = vi.fn<PingWorkflowRuntime['startPingWorkflow']>().mockResolvedValue({
      runId: 'run-2',
      taskQueue: 'careos.phase0',
      workflowId: 'phase0-ping-2',
    });
    const controller = new TemporalController({ startPingWorkflow });

    await controller.startPing({ message: '' });

    expect(startPingWorkflow).toHaveBeenCalledWith(undefined);
  });
});
