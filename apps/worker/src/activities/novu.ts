import type {
  DispatchHandoverNotificationsInput,
  DispatchHandoverNotificationsResult,
} from '@careos/contracts';

import { withTenantContext } from '../db/pg.js';

export async function dispatchHandoverNotifications(
  input: DispatchHandoverNotificationsInput,
): Promise<DispatchHandoverNotificationsResult> {
  if ((process.env.NOVU_PROVIDER ?? 'stub') === 'disabled' || input.taskIds.length === 0) {
    return { dispatched: false };
  }

  const outboxId = input.handoverId;
  await withTenantContext(
    {
      actor: input.actor,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      await client.query(
        `INSERT INTO core.outbox
           (id, tenant_id, home_id, topic, payload, status, attempts, available_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'novu.handover.follow_ups', $4::jsonb,
           'pending', 0, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [
          outboxId,
          input.tenantId,
          input.homeId,
          JSON.stringify({
            assigneeUserIds: input.assigneeUserIds,
            handoverId: input.handoverId,
            nextShiftId: input.nextShiftId ?? null,
            shiftId: input.shiftId,
            taskIds: input.taskIds,
          }),
        ],
      );
    },
  );

  return { dispatched: true, outboxId };
}
