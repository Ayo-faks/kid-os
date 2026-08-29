import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, () => unknown>();
const activityMocks = vi.hoisted(() => ({
  analyzeRota: vi.fn(),
  loadRotaContext: vi.fn(),
  narrateRotaAnalysis: vi.fn(),
  publishRota: vi.fn(),
}));

vi.mock('@temporalio/workflow', () => ({
  defineQuery: vi.fn((name: string) => name),
  proxyActivities: vi.fn(() => activityMocks),
  setHandler: vi.fn((definition: string, handler: () => unknown) => {
    handlers.set(definition, handler);
  }),
}));

import { RotaAnalyzeWorkflow } from './rota-analyze.workflow.js';
import { RotaPublishWorkflow } from './rota-publish.workflow.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const publicationId = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';
const shiftId = '55555555-5555-4555-8555-555555555555';

describe('rota workflows', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
  });

  it('assembles deterministic analysis and forwards agent telemetry to narration', async () => {
    const shift = {
      assignedUserIds: [] as string[],
      endsAt: '2026-05-18T15:00:00.000Z',
      id: shiftId,
      minHeadcount: 2,
      requiredRole: 'support_worker',
      startsAt: '2026-05-18T07:00:00.000Z',
    };
    const gap = {
      detail: 'One support worker is missing.',
      kind: 'min_staffing' as const,
      ruleId: 'rule-1',
      ruleName: 'Minimum support workers',
      severity: 'high' as const,
      shiftId,
    };
    activityMocks.loadRotaContext.mockResolvedValue({ rules: [], shifts: [shift], staff: [] });
    activityMocks.analyzeRota.mockResolvedValue({ gaps: [gap], proposals: [] });
    activityMocks.narrateRotaAnalysis.mockResolvedValue({
      narration: 'Coverage gap detected.',
      promptHash: 'prompt-hash',
      refused: false,
    });

    const result = await RotaAnalyzeWorkflow({
      actor: {
        agentRunId: 'agent-run-1',
        correlationId: 'corr-rota',
        kind: 'agent',
        userId: null,
      },
      correlationId: 'corr-rota',
      homeId,
      periodEnd: '2026-05-25T00:00:00.000Z',
      periodStart: '2026-05-18T00:00:00.000Z',
      requestedByUserId: userId,
      tenantId,
    });

    expect(activityMocks.narrateRotaAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunId: 'agent-run-1', correlationId: 'corr-rota' }),
    );
    expect(result).toMatchObject({ gaps: [gap], narration: 'Coverage gap detected.' });
  });

  it('persists the canonical workflow id and exposes published state', async () => {
    activityMocks.publishRota.mockResolvedValue({
      publicationId,
      publishedAssignmentIds: ['assignment-1'],
      status: 'published',
    });

    await RotaPublishWorkflow(publishInput());

    expect(activityMocks.publishRota).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: `rota-publish-${publicationId}` }),
    );
    expect(handlers.get('getState')?.()).toEqual({
      publicationId,
      publishedAssignmentIds: ['assignment-1'],
      status: 'published',
    });
  });

  it('exposes failed state when publication exhausts activity retries', async () => {
    activityMocks.publishRota.mockRejectedValue(new Error('database unavailable'));

    await expect(RotaPublishWorkflow(publishInput())).rejects.toThrow('database unavailable');
    expect(handlers.get('getState')?.()).toEqual({
      publicationId,
      publishedAssignmentIds: [],
      status: 'failed',
    });
  });
});

function publishInput() {
  return {
    actor: { correlationId: 'corr-publish', kind: 'user' as const, userId },
    correlationId: 'corr-publish',
    homeId,
    periodEnd: '2026-05-25T00:00:00.000Z',
    periodStart: '2026-05-18T00:00:00.000Z',
    publicationId,
    publishedByUserId: userId,
    shiftIds: [shiftId],
    tenantId,
  };
}
