import { handoverWorkflowId, type HandoverActor } from '@careos/contracts';
import { describe, expect, it, vi } from 'vitest';

import { CreateHandoverSchema } from './dto.js';
import { HandoversService } from './handovers.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const shiftId = '33333333-3333-4333-8333-333333333333';
const authorUserId = '44444444-4444-4444-8444-444444444444';
const correlationId = 'corr-handover';

const actor: HandoverActor = {
  correlationId,
  kind: 'user',
  userId: authorUserId,
};

const requestContext = {
  actor,
  authorUserId,
  correlationId,
  homeId,
  tenantId,
};

describe('Handover DTO schemas', () => {
  it('CreateHandover requires a shift id and meaningful free text', () => {
    expect(
      CreateHandoverSchema.safeParse({
        free_text: 'Night shift handover notes with enough detail.',
        shift_id: shiftId,
      }).success,
    ).toBe(true);

    expect(
      CreateHandoverSchema.safeParse({
        free_text: 'too short',
        shift_id: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });
});

describe('HandoversService', () => {
  it('create() starts HandoverWorkflow and does not persist directly', async () => {
    const temporal = createTemporalMock();
    const service = new HandoversService(
      temporal as unknown as ConstructorParameters<typeof HandoversService>[0],
    );

    const result = await service.create(
      {
        free_text: 'Night shift was calm. Jamie needs a morning check-in.',
        shift_id: shiftId,
      },
      requestContext,
    );

    expect(temporal.startHandoverWorkflow).toHaveBeenCalledTimes(1);
    const args = temporal.startHandoverWorkflow.mock.calls[0]?.[0] as
      | { handoverId: string; tenantId: string; homeId: string }
      | undefined;
    expect(args).toMatchObject({
      authorUserId,
      correlationId,
      freeText: 'Night shift was calm. Jamie needs a morning check-in.',
      homeId,
      shiftId,
      tenantId,
    });
    expect(args?.handoverId).toMatch(/^[0-9a-f-]{36}$/);

    expect(result).toEqual({
      id: args?.handoverId,
      status: 'processing',
      workflowId: handoverWorkflowId(args?.handoverId ?? ''),
    });
  });
});

function createTemporalMock(): {
  readonly startHandoverWorkflow: ReturnType<typeof vi.fn>;
} {
  return {
    startHandoverWorkflow: vi.fn((input: { handoverId: string }) => ({
      handoverId: input.handoverId,
      runId: 'run-1',
      taskQueue: 'careos.handovers',
      workflowId: handoverWorkflowId(input.handoverId),
    })),
  };
}
