import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());
const withSystemContextMock = vi.hoisted(() => vi.fn());

vi.mock('../db/pg.js', () => ({
  withSystemContext: withSystemContextMock,
  withTenantContext: withTenantContextMock,
}));

import {
  findIncidentsMissingMandatoryFields,
  loadMissingFieldsContext,
  markMissingFieldsReminderSent,
} from './missing-fields-audit.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const incidentId = '33333333-3333-4333-8333-333333333333';
const residentId = '44444444-4444-4444-8444-444444444444';
const correlationId = 'corr-missing-fields-test';

const actor = {
  correlationId,
  kind: 'system' as const,
  userId: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('findIncidentsMissingMandatoryFields', () => {
  it('queries incidents older than the cutoff under system context', async () => {
    const createdAt = new Date('2026-05-16T10:00:00.000Z');
    const query = mockSystemClient([
      {
        rowCount: 1,
        rows: [
          {
            created_at: createdAt,
            home_id: homeId,
            id: incidentId,
            missing_mandatory: ['witnesses', 'severity'],
            resident_id: residentId,
            tenant_id: tenantId,
          },
        ],
      },
    ]);

    const result = await findIncidentsMissingMandatoryFields({
      correlationId,
      minAgeMinutes: 1440,
      nowIso: '2026-05-18T10:00:00.000Z',
    });

    expect(result.incidents).toEqual([
      {
        createdAtIso: createdAt.toISOString(),
        homeId,
        incidentId,
        missingFields: ['witnesses', 'severity'],
        residentId,
        tenantId,
      },
    ]);
    expect(withSystemContextMock).toHaveBeenCalledWith({ correlationId }, expect.any(Function));
    const [, params] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(params).toEqual(['2026-05-17T10:00:00.000Z']);
  });

  it('returns an empty list when no rows match', async () => {
    mockSystemClient([{ rowCount: 0, rows: [] }]);
    const result = await findIncidentsMissingMandatoryFields({
      correlationId,
      minAgeMinutes: 1440,
      nowIso: '2026-05-18T10:00:00.000Z',
    });
    expect(result.incidents).toEqual([]);
  });
});

describe('loadMissingFieldsContext', () => {
  it('returns null when the incident is not visible in the tenant scope', async () => {
    mockTenantClient([{ rowCount: 0, rows: [] }]);
    const ctx = await loadMissingFieldsContext({
      actor,
      homeId,
      incidentId,
      tenantId,
    });
    expect(ctx).toBeNull();
  });

  it('returns context with missing fields and status', async () => {
    const createdAt = new Date('2026-05-16T10:00:00.000Z');
    mockTenantClient([
      {
        rowCount: 1,
        rows: [
          {
            created_at: createdAt,
            id: incidentId,
            missing_fields_reminder_sent_at: null,
            missing_mandatory: ['witnesses'],
            resident_id: residentId,
            status: 'awaiting_fields',
          },
        ],
      },
    ]);

    const ctx = await loadMissingFieldsContext({
      actor,
      homeId,
      incidentId,
      tenantId,
    });

    expect(ctx).toEqual({
      alreadyReminded: false,
      createdAtIso: createdAt.toISOString(),
      incidentId,
      missingFields: ['witnesses'],
      residentId,
      status: 'awaiting_fields',
    });
  });

  it('reports already-reminded when missing_fields_reminder_sent_at is set', async () => {
    const createdAt = new Date('2026-05-16T10:00:00.000Z');
    mockTenantClient([
      {
        rowCount: 1,
        rows: [
          {
            created_at: createdAt,
            id: incidentId,
            missing_fields_reminder_sent_at: new Date('2026-05-17T08:00:00.000Z'),
            missing_mandatory: ['witnesses'],
            resident_id: residentId,
            status: 'awaiting_fields',
          },
        ],
      },
    ]);

    const ctx = await loadMissingFieldsContext({
      actor,
      homeId,
      incidentId,
      tenantId,
    });

    expect(ctx?.alreadyReminded).toBe(true);
  });
});

describe('markMissingFieldsReminderSent', () => {
  it('returns recorded=true on the first call', async () => {
    mockTenantClient([{ rowCount: 1, rows: [] }]);
    const result = await markMissingFieldsReminderSent({
      actor,
      homeId,
      incidentId,
      tenantId,
    });
    expect(result.recorded).toBe(true);
  });

  it('returns recorded=false when the column is already populated', async () => {
    mockTenantClient([{ rowCount: 0, rows: [] }]);
    const result = await markMissingFieldsReminderSent({
      actor,
      homeId,
      incidentId,
      tenantId,
    });
    expect(result.recorded).toBe(false);
  });
});

function mockTenantClient(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>();
  for (const result of results) {
    query.mockResolvedValueOnce(result);
  }
  withTenantContextMock.mockImplementation(
    (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) =>
      callback({ query } as unknown as PoolClient),
  );
  return query;
}

function mockSystemClient(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>();
  for (const result of results) {
    query.mockResolvedValueOnce(result);
  }
  withSystemContextMock.mockImplementation(
    (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) =>
      callback({ query } as unknown as PoolClient),
  );
  return query;
}
