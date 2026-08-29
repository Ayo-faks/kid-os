import {
  ROTA_QUERIES,
  rotaPublishWorkflowId,
  type RotaPublishStateQuery,
  type RotaPublishWorkflowInput,
} from '@careos/contracts/workflow';
import { defineQuery, proxyActivities, setHandler } from '@temporalio/workflow';

import type * as rotaActivities from '../activities/rota.js';

const { publishRota } = proxyActivities<typeof rotaActivities>({
  retry: { initialInterval: '1 second', maximumAttempts: 5 },
  startToCloseTimeout: '60 seconds',
});

export async function RotaPublishWorkflow(input: RotaPublishWorkflowInput): Promise<void> {
  let state: RotaPublishStateQuery = {
    publicationId: input.publicationId,
    publishedAssignmentIds: [],
    status: 'processing',
  };
  setHandler(defineQuery<RotaPublishStateQuery>(ROTA_QUERIES.getState), () => state);

  try {
    const result = await publishRota({
      actor: input.actor,
      homeId: input.homeId,
      note: input.note,
      periodEnd: input.periodEnd,
      periodStart: input.periodStart,
      publicationId: input.publicationId,
      publishedByUserId: input.publishedByUserId,
      shiftIds: input.shiftIds,
      tenantId: input.tenantId,
      workflowId: rotaPublishWorkflowId(input.publicationId),
    });

    state = {
      publicationId: result.publicationId,
      publishedAssignmentIds: result.publishedAssignmentIds,
      status: result.status,
    };
  } catch (error) {
    state = { ...state, status: 'failed' };
    throw error;
  }
}
