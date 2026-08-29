import type { IncidentActor } from '@careos/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ExportBundlesService } from './export-bundles.service.js';

const incidentId = '44444444-4444-4444-8444-444444444444';
const requestedByUserId = '55555555-5555-4555-8555-555555555555';
const actor: IncidentActor = {
  correlationId: 'corr-export-bundle',
  kind: 'user',
  userId: requestedByUserId,
};
const context = {
  actor,
  correlationId: actor.correlationId,
  homeId: '22222222-2222-4222-8222-222222222222',
  requestedByUserId,
  tenantId: '11111111-1111-4111-8111-111111111111',
};

describe('ExportBundlesService.request', () => {
  it('starts a bundle workflow for an approved incident', async () => {
    const harness = createHarness([{ id: incidentId, status: 'approved' }]);

    const result = await harness.service.request({ incident_id: incidentId }, context);

    expect(result).toMatchObject({ status: 'pending' });
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(harness.transaction.$executeRaw).toHaveBeenCalledTimes(1);
    expect(harness.temporal.startSeriousIncidentExportWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        bundleId: result.id,
        homeId: context.homeId,
        incidentId,
        tenantId: context.tenantId,
      }),
    );
  });

  it('rejects a pre-approval bundle without writing or starting Temporal', async () => {
    const harness = createHarness([{ id: incidentId, status: 'awaiting_approval' }]);

    await expect(harness.service.request({ incident_id: incidentId }, context)).rejects.toThrow(
      /only approved incidents/i,
    );
    expect(harness.transaction.$executeRaw).not.toHaveBeenCalled();
    expect(harness.temporal.startSeriousIncidentExportWorkflow).not.toHaveBeenCalled();
  });
});

function createHarness(incidentRows: readonly { readonly id: string; readonly status: string }[]) {
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue(incidentRows),
  };
  const prisma = {
    withTenantContext: vi.fn(
      (_context: unknown, callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
  const storage = {};
  const temporal = {
    startSeriousIncidentExportWorkflow: vi.fn((input: { readonly bundleId: string }) =>
      Promise.resolve({ workflowId: `serious-incident-export-${input.bundleId}` }),
    ),
  };
  const service = new ExportBundlesService(
    prisma as unknown as ConstructorParameters<typeof ExportBundlesService>[0],
    storage as unknown as ConstructorParameters<typeof ExportBundlesService>[1],
    temporal as unknown as ConstructorParameters<typeof ExportBundlesService>[2],
  );
  return { service, temporal, transaction };
}
