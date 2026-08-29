import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

const withTenantContextMock = vi.hoisted(() => vi.fn());
vi.mock('../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import { ensureIncidentFollowUpActions, loadSafeguardingContact } from './incident-follow-ups.js';

const actor = {
  correlationId: 'corr-follow-up',
  kind: 'user' as const,
  userId: '55555555-5555-4555-8555-555555555555',
};
const base = {
  actor,
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '44444444-4444-4444-8444-444444444444',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('incident follow-up activities', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates exactly the governed actions with deterministic identities', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 2,
        rows: [
          {
            action_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            attempt: 1,
            kind: 'export_bundle',
            target_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            workflow_id: 'export-workflow',
          },
          {
            action_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            attempt: 1,
            kind: 'safeguarding_email',
            target_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            workflow_id: 'email-workflow',
          },
        ],
      });
    useClient(query);

    const actions = await ensureIncidentFollowUpActions({
      ...base,
      immediateRisk: false,
      safeguarding: true,
    });

    expect(actions.map((action) => action.kind)).toEqual(['export_bundle', 'safeguarding_email']);
    expect(actions.every((action) => /^[0-9a-f-]{36}$/.test(action.targetId))).toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT');
  });

  it('does not touch the database for a routine incident', async () => {
    const query = vi.fn();
    useClient(query);
    await expect(
      ensureIncidentFollowUpActions({ ...base, immediateRisk: false, safeguarding: false }),
    ).resolves.toEqual([]);
    expect(withTenantContextMock).not.toHaveBeenCalled();
  });

  it('registers and verifies Durable ownership for every governed action', async () => {
    const actions = [
      {
        action_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        attempt: 1,
        kind: 'export_bundle',
        target_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        workflow_id: 'export-workflow',
      },
      {
        action_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        attempt: 1,
        kind: 'safeguarding_email',
        target_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        workflow_id: 'email-workflow',
      },
    ];
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 2, rows: actions })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ instance_id: 'export-workflow', runtime: 'durable' }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ instance_id: 'email-workflow', runtime: 'durable' }],
      });
    useClient(query);

    await expect(
      ensureIncidentFollowUpActions({
        ...base,
        immediateRisk: false,
        orchestrationName: 'IncidentFollowUpActionOrchestratorV1',
        orchestrationVersion: '1.0.0',
        runtime: 'durable',
        safeguarding: true,
      }),
    ).resolves.toHaveLength(2);

    expect(query.mock.calls[3]?.[0]).toContain("'incident-follow-up'");
    expect(query.mock.calls[5]?.[0]).toContain("'incident-follow-up'");
    expect(query).toHaveBeenCalledTimes(7);
  });

  it('returns an explicit unconfigured result instead of guessing a recipient', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ email: null, name: null }] });
    useClient(query);
    await expect(
      loadSafeguardingContact({
        actionId: 'action-1',
        actor,
        homeId: base.homeId,
        tenantId: base.tenantId,
      }),
    ).resolves.toEqual({ configured: false });
  });
});

function useClient(query: ReturnType<typeof vi.fn>): void {
  withTenantContextMock.mockImplementation(
    (_context: unknown, callback: (client: PoolClient) => Promise<unknown>) =>
      callback({ query } as unknown as PoolClient),
  );
}
