import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const digestMocks = vi.hoisted(() => ({
  findSafeguardingDigestTargets: vi.fn(),
  hasSafeguardingDigestAudit: vi.fn(),
  loadSafeguardingDigest: vi.fn(),
  recordSafeguardingDigestAudit: vi.fn(),
}));
const postMattermostMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/mattermost.js', () => ({
  postMattermostMessage: postMattermostMessageMock,
}));
vi.mock('../../activities/safeguarding-digest.js', () => digestMocks);

import {
  calculateNextSafeguardingDigestFireActivity,
  findSafeguardingDigestTargetsActivity,
  processSafeguardingDigestDeliveryActivity,
} from './safeguarding-digest.activities.js';

const context = new ActivityContext('safeguarding-digest-test', 1);
const input = {
  correlationId: 'corr-safeguarding-digest',
  homeId: '22222222-2222-4222-8222-222222222222',
  nowIso: '2026-07-20T07:00:00.000Z',
  sinceIso: '2026-07-13T07:00:00.000Z',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('Durable Safeguarding Digest activities', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ['winter before Monday fire', '2026-01-05T07:30:00.000Z', '2026-01-05T08:00:00.000Z'],
    ['winter after Monday fire', '2026-01-05T09:00:00.000Z', '2026-01-12T08:00:00.000Z'],
    ['summer before Monday fire', '2026-07-20T06:30:00.000Z', '2026-07-20T07:00:00.000Z'],
    ['summer after Monday fire', '2026-07-20T08:00:00.000Z', '2026-07-27T07:00:00.000Z'],
    ['spring DST week', '2026-03-29T09:00:00.000Z', '2026-03-30T07:00:00.000Z'],
    ['autumn DST week', '2026-10-25T09:00:00.000Z', '2026-10-26T08:00:00.000Z'],
  ])('calculates Monday 08:00 Europe/London for %s', (_title, afterIso, expected) => {
    expect(calculateNextSafeguardingDigestFireActivity(context, { afterIso })).toBe(expected);
  });

  it('returns opaque target IDs only', async () => {
    digestMocks.findSafeguardingDigestTargets.mockResolvedValue({
      targets: [{ homeId: input.homeId, tenantId: input.tenantId }],
    });
    await expect(
      findSafeguardingDigestTargetsActivity(context, {
        correlationId: input.correlationId,
      }),
    ).resolves.toEqual({ targets: [{ homeId: input.homeId, tenantId: input.tenantId }] });
  });

  it('reconciles prior audit evidence without posting again', async () => {
    digestMocks.hasSafeguardingDigestAudit.mockResolvedValue(true);

    await expect(processSafeguardingDigestDeliveryActivity(context, input)).resolves.toEqual({
      dispatched: true,
      outcomeCode: 'already-recorded',
    });
    expect(digestMocks.loadSafeguardingDigest).not.toHaveBeenCalled();
    expect(postMattermostMessageMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'provider failure',
      { delivered: false, reason: 'private provider detail' },
      { recorded: false },
      { dispatched: false, outcomeCode: 'provider-not-delivered' },
    ],
    [
      'audit failure',
      { delivered: true },
      { recorded: false },
      { dispatched: false, outcomeCode: 'audit-not-recorded' },
    ],
    ['delivery', { delivered: true }, { recorded: true }, { dispatched: true }],
  ])('returns aggregate-only output for %s', async (_title, post, audit, expected) => {
    digestMocks.hasSafeguardingDigestAudit.mockResolvedValue(false);
    digestMocks.loadSafeguardingDigest.mockResolvedValue({
      incidentsAwaitingAction: 5,
      incidentsOpened: 8,
      nowIso: input.nowIso,
      sensitiveEmailDrafts: 3,
      sinceIso: input.sinceIso,
    });
    postMattermostMessageMock.mockResolvedValue(post);
    digestMocks.recordSafeguardingDigestAudit.mockResolvedValue(audit);

    const result = await processSafeguardingDigestDeliveryActivity(context, input);

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/private provider detail|incidents|sensitive/i);
    expect(postMattermostMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: `safeguarding-digest:${input.tenantId}:${input.homeId}:${input.nowIso}`,
      }),
    );
  });

  it('masks detailed digest failures', async () => {
    digestMocks.hasSafeguardingDigestAudit.mockRejectedValue(
      new Error('private safeguarding data failed'),
    );
    await expect(processSafeguardingDigestDeliveryActivity(context, input)).rejects.toThrow(
      'Safeguarding digest delivery processing failed.',
    );
  });
});
