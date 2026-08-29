import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auditMocks = vi.hoisted(() => ({
  findIncidentsMissingMandatoryFields: vi.fn(),
  loadMissingFieldsContext: vi.fn(),
  markMissingFieldsReminderSent: vi.fn(),
}));
const postMattermostMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/mattermost.js', () => ({
  postMattermostMessage: postMattermostMessageMock,
}));
vi.mock('../../activities/missing-fields-audit.js', () => auditMocks);

import {
  findMissingFieldsTargetsActivity,
  processMissingFieldsDeliveryActivity,
} from './missing-fields-audit.activities.js';

const context = new ActivityContext('missing-fields-test', 1);
const input = {
  correlationId: 'corr-missing-fields',
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('Durable Missing Fields activities', () => {
  afterEach(() => vi.clearAllMocks());

  it('strips resident, timestamps, and field names from scheduler-visible targets', async () => {
    auditMocks.findIncidentsMissingMandatoryFields.mockResolvedValue({
      incidents: [
        {
          createdAtIso: '2026-07-17T00:00:00.000Z',
          homeId: input.homeId,
          incidentId: input.incidentId,
          missingFields: ['private-resident-detail'],
          residentId: '44444444-4444-4444-8444-444444444444',
          tenantId: input.tenantId,
        },
      ],
    });

    const result = await findMissingFieldsTargetsActivity(context, {
      correlationId: input.correlationId,
      minAgeMinutes: 1_440,
      nowIso: '2026-07-18T00:00:00.000Z',
    });

    expect(result).toEqual({
      targets: [{ homeId: input.homeId, incidentId: input.incidentId, tenantId: input.tenantId }],
    });
    expect(JSON.stringify(result)).not.toMatch(/resident|private-resident-detail|createdAt/i);
  });

  it.each([
    [
      'missing',
      null,
      undefined,
      undefined,
      { dispatched: false, outcomeCode: 'incident-not-found' },
    ],
    [
      'reminded',
      loaded({ alreadyReminded: true }),
      undefined,
      undefined,
      { dispatched: false, outcomeCode: 'already-reminded' },
    ],
    [
      'complete',
      loaded({ missingFields: [] }),
      undefined,
      undefined,
      { dispatched: false, outcomeCode: 'no-missing-fields' },
    ],
    [
      'terminal status',
      loaded({ status: 'private-custom-status' }),
      undefined,
      undefined,
      { dispatched: false, outcomeCode: 'status-not-remindable' },
    ],
    [
      'provider failure',
      loaded(),
      { delivered: false, reason: 'private provider detail' },
      undefined,
      { dispatched: false, outcomeCode: 'provider-not-delivered' },
    ],
    ['delivery', loaded(), { delivered: true }, { recorded: true }, { dispatched: true }],
  ])('returns a closed outcome for %s', async (_title, loadedResult, post, mark, expected) => {
    auditMocks.loadMissingFieldsContext.mockResolvedValue(loadedResult);
    postMattermostMessageMock.mockResolvedValue(post);
    auditMocks.markMissingFieldsReminderSent.mockResolvedValue(mark);

    const result = await processMissingFieldsDeliveryActivity(context, input);

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/private provider detail|private-custom-status/);
    if (post !== undefined) {
      expect(postMattermostMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: `missing-fields-reminder:${input.incidentId}` }),
      );
    }
  });

  it('masks detailed target and delivery errors', async () => {
    auditMocks.findIncidentsMissingMandatoryFields.mockRejectedValue(
      new Error('private resident field failed'),
    );
    await expect(
      findMissingFieldsTargetsActivity(context, {
        correlationId: input.correlationId,
        minAgeMinutes: 1_440,
        nowIso: '2026-07-18T00:00:00.000Z',
      }),
    ).rejects.toThrow('Missing fields target lookup failed.');

    auditMocks.loadMissingFieldsContext.mockRejectedValue(new Error('private incident failed'));
    await expect(processMissingFieldsDeliveryActivity(context, input)).rejects.toThrow(
      'Missing fields delivery processing failed.',
    );
  });
});

function loaded(overrides: Record<string, unknown> = {}) {
  return {
    alreadyReminded: false,
    createdAtIso: '2026-07-17T00:00:00.000Z',
    incidentId: input.incidentId,
    missingFields: ['body_map', 'resident_view'],
    residentId: '44444444-4444-4444-8444-444444444444',
    status: 'draft',
    ...overrides,
  };
}
