import {
  HANDOVER_QUERIES,
  handoverWorkflowId,
  type HandoverActor,
  type HandoverStateQuery,
  type HandoverStatus,
  type HandoverWorkflowInput,
} from '@careos/contracts/workflow';
import { defineQuery, proxyActivities, setHandler } from '@temporalio/workflow';

import type * as handoverActivities from '../activities/handovers.js';
import type * as novuActivities from '../activities/novu.js';

const { persistHandover, summarizeHandover, validateHandover } = proxyActivities<
  typeof handoverActivities
>({
  retry: {
    initialInterval: '1 second',
    maximumAttempts: 5,
  },
  startToCloseTimeout: '30 seconds',
});

const { dispatchHandoverNotifications } = proxyActivities<typeof novuActivities>({
  retry: {
    initialInterval: '1 second',
    maximumAttempts: 5,
  },
  startToCloseTimeout: '30 seconds',
});

const getStateQuery = defineQuery<HandoverStateQuery>(HANDOVER_QUERIES.getState);

export async function HandoverWorkflow(input: HandoverWorkflowInput): Promise<void> {
  const workflowId = handoverWorkflowId(input.handoverId);
  let status: HandoverStatus = 'processing';
  let taskIds: readonly string[] = [];
  let missingMandatory: readonly string[] = [];

  setHandler(getStateQuery, () => ({
    handoverId: input.handoverId,
    missingMandatory,
    status,
    taskIds,
  }));

  const summary = await summarizeHandover({
    agentRunId: undefined,
    correlationId: input.correlationId,
    freeText: input.freeText,
    homeId: input.homeId,
    shiftId: input.shiftId,
    tenantId: input.tenantId,
    transcriptObjectKey: input.transcriptObjectKey,
  });

  const formData = {
    ...summary.formData,
    shiftId: input.shiftId,
  } satisfies Record<string, unknown>;
  const validation = await validateHandover({ formData });
  missingMandatory = validation.missingMandatory;
  if (!validation.valid) {
    status = 'failed';
    throw new Error(
      `Handover ${input.handoverId} failed validation: ${validation.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join('; ')}`,
    );
  }

  const actor: HandoverActor = {
    correlationId: input.correlationId,
    kind: 'user',
    promptHash: summary.promptHash,
    userId: input.authorUserId,
  };
  const persisted = await persistHandover({
    actor,
    authorUserId: input.authorUserId,
    formData,
    handoverId: input.handoverId,
    homeId: input.homeId,
    shiftId: input.shiftId,
    sourceText: input.freeText,
    summary: summary.summary,
    tenantId: input.tenantId,
    transcriptObjectKey: input.transcriptObjectKey,
    workflowId,
  });
  taskIds = persisted.taskIds;

  await dispatchHandoverNotifications({
    actor,
    assigneeUserIds: persisted.assigneeUserIds,
    handoverId: input.handoverId,
    homeId: input.homeId,
    nextShiftId: persisted.nextShiftId,
    shiftId: input.shiftId,
    taskIds: persisted.taskIds,
    tenantId: input.tenantId,
  });

  status = 'completed';
}
