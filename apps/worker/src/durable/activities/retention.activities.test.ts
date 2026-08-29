import { ActivityContext, OrchestrationStatus } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const retentionMocks = vi.hoisted(() => ({
  applyRetentionPolicy: vi.fn(),
  listActiveRetentionPolicies: vi.fn(),
}));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/retention.js', () => retentionMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import {
  calculateNextRetentionFireActivity,
  createStartRetentionSweepActivity,
  finalizeRetentionSweepFailureActivity,
  processRetentionSweepActivity,
} from './retention.activities.js';

const context = new ActivityContext('retention-test', 1);
const owner = {
  homeId: '22222222-2222-4222-8222-222222222222',
  tenantId: '11111111-1111-4111-8111-111111111111',
  workflowInstanceId: '99999999-9999-4999-8999-999999999999',
};
const input = {
  correlationId: 'corr-retention',
  nowIso: '2026-07-18T02:00:00.000Z',
  owner,
  sweepId: '44444444-4444-4444-8444-444444444444',
};

describe('Durable Retention activities', () => {
  afterEach(() => vi.clearAllMocks());

  it('processes policies internally and returns aggregate operational counts only', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    withTenantContextMock.mockImplementation(
      (_context: unknown, callback: (client: { query: typeof query }) => Promise<unknown>) =>
        callback({ query }),
    );
    retentionMocks.listActiveRetentionPolicies.mockResolvedValue({
      policies: [policy('incident'), policy('attachment')],
    });
    retentionMocks.applyRetentionPolicy
      .mockResolvedValueOnce({ affectedCount: 3, runId: 'private-run-1', scannedCount: 4 })
      .mockResolvedValueOnce({ affectedCount: 2, runId: 'private-run-2', scannedCount: 2 });

    const result = await processRetentionSweepActivity(context, input);

    expect(result).toEqual({
      policiesApplied: 2,
      sweepId: input.sweepId,
      totalAffected: 5,
      totalScanned: 6,
    });
    expect(JSON.stringify(result)).not.toContain('private-run');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('core.workflow_instances'), [
      owner.workflowInstanceId,
      'completed',
    ]);
  });

  it('converts detailed policy failures to a generic scheduler error', async () => {
    retentionMocks.listActiveRetentionPolicies.mockResolvedValue({
      policies: [policy('incident')],
    });
    retentionMocks.applyRetentionPolicy.mockRejectedValue(
      new Error('private attachment object key failed'),
    );

    await expect(
      processRetentionSweepActivity(context, { ...input, owner: undefined }),
    ).rejects.toThrow('Retention sweep processing failed.');
  });

  it('marks a persisted manual owner failed during orchestration finalization', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    withTenantContextMock.mockImplementation(
      (_context: unknown, callback: (client: { query: typeof query }) => Promise<unknown>) =>
        callback({ query }),
    );

    await finalizeRetentionSweepFailureActivity(context, input);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('core.workflow_instances'), [
      owner.workflowInstanceId,
      'failed',
    ]);
  });

  it.each([
    ['winter same day', '2026-01-10T00:30:00.000Z', '2026-01-10T02:00:00.000Z'],
    ['winter next day', '2026-01-10T03:00:00.000Z', '2026-01-11T02:00:00.000Z'],
    ['summer', '2026-07-18T00:30:00.000Z', '2026-07-18T01:00:00.000Z'],
    ['spring DST boundary', '2026-03-29T00:30:00.000Z', '2026-03-29T01:00:00.000Z'],
    ['autumn DST boundary', '2026-10-25T00:30:00.000Z', '2026-10-25T02:00:00.000Z'],
  ])('calculates 02:00 Europe/London for %s', (_title, afterIso, expected) => {
    expect(
      calculateNextRetentionFireActivity(context, {
        afterIso,
        hourLocal: 2,
        timeZone: 'Europe/London',
      }),
    ).toBe(expected);
  });

  it('starts a version-pinned detached sweep and reconciles a lost acknowledgement', async () => {
    const sweepInstanceId = `retention-sweep-${input.sweepId}`;
    const client = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValue({ runtimeStatus: OrchestrationStatus.RUNNING }),
      scheduleNewOrchestration: vi.fn().mockRejectedValue(new Error('response lost')),
    };

    await expect(
      createStartRetentionSweepActivity(client)(context, {
        correlationId: input.correlationId,
        nowIso: input.nowIso,
        sweepId: input.sweepId,
        sweepInstanceId,
      }),
    ).resolves.toBe(sweepInstanceId);
    expect(client.getOrchestrationState).toHaveBeenCalledWith(sweepInstanceId, false);
  });
});

function policy(recordType: 'attachment' | 'incident') {
  return {
    action: recordType === 'attachment' ? ('object_delete' as const) : ('soft_delete' as const),
    enabled: true,
    id:
      recordType === 'attachment'
        ? '77777777-7777-4777-8777-777777777777'
        : '66666666-6666-4666-8666-666666666666',
    recordType,
    retentionDays: 365,
    tenantId: owner.tenantId,
  };
}
