import type { ActivityContext } from '@microsoft/durabletask-js';

import { postMattermostMessage } from '../../activities/mattermost.js';
import {
  findIncidentsMissingMandatoryFields,
  loadMissingFieldsContext,
  markMissingFieldsReminderSent,
} from '../../activities/missing-fields-audit.js';
import {
  type CalculateNextMissingFieldsFireInput,
  type FindMissingFieldsTargetsInput,
  type FindMissingFieldsTargetsResult,
  MISSING_FIELDS_ORCHESTRATION_VERSION,
  type MissingFieldsDeliveryInput,
  type MissingFieldsDeliveryResult,
  MISSING_FIELDS_SWEEP_ORCHESTRATOR,
  SEND_MISSING_FIELDS_ORCHESTRATOR,
  type StartMissingFieldsDeliveryInput,
  type StartMissingFieldsSweepInput,
} from '../missing-fields-audit.contracts.js';
import {
  type DurableOrchestrationStarter,
  scheduleDurableOrchestrationIdempotently,
} from '../orchestration-starter.js';
import { assertDurableInstanceId, assertDurablePayload } from '../payload-policy.js';

export function calculateNextMissingFieldsFireActivity(
  _context: ActivityContext,
  input: CalculateNextMissingFieldsFireInput,
): string {
  const after = new Date(input.afterIso);
  if (Number.isNaN(after.getTime())) throw new Error('Missing fields afterIso is invalid.');
  if (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds <= 0) {
    throw new Error('Missing fields intervalSeconds must be greater than zero.');
  }
  const intervalMilliseconds = input.intervalSeconds * 1_000;
  return new Date(
    Math.floor(after.getTime() / intervalMilliseconds + 1) * intervalMilliseconds,
  ).toISOString();
}

export async function findMissingFieldsTargetsActivity(
  _context: ActivityContext,
  input: FindMissingFieldsTargetsInput,
): Promise<FindMissingFieldsTargetsResult> {
  try {
    const result = await findIncidentsMissingMandatoryFields(input);
    return {
      targets: result.incidents.map((incident) => ({
        homeId: incident.homeId,
        incidentId: incident.incidentId,
        tenantId: incident.tenantId,
      })),
    };
  } catch {
    throw new Error('Missing fields target lookup failed.');
  }
}

export async function processMissingFieldsDeliveryActivity(
  _context: ActivityContext,
  input: MissingFieldsDeliveryInput,
): Promise<MissingFieldsDeliveryResult> {
  try {
    const actor = { correlationId: input.correlationId, kind: 'system' as const, userId: null };
    const loaded = await loadMissingFieldsContext({
      actor,
      homeId: input.homeId,
      incidentId: input.incidentId,
      tenantId: input.tenantId,
    });
    if (loaded === null) return { dispatched: false, outcomeCode: 'incident-not-found' };
    if (loaded.alreadyReminded) return { dispatched: false, outcomeCode: 'already-reminded' };
    if (loaded.missingFields.length === 0) {
      return { dispatched: false, outcomeCode: 'no-missing-fields' };
    }
    if (loaded.status !== 'draft' && loaded.status !== 'awaiting_fields') {
      return { dispatched: false, outcomeCode: 'status-not-remindable' };
    }

    const fieldList = loaded.missingFields.slice(0, 6).join(', ');
    const extra =
      loaded.missingFields.length > 6 ? ` (+${loaded.missingFields.length - 6} more)` : '';
    const post = await postMattermostMessage({
      actor,
      channelKind: 'home',
      deliveryId: `missing-fields-reminder:${input.incidentId}`,
      homeId: input.homeId,
      message:
        `Incident draft ${loaded.incidentId} is missing mandatory fields ` +
        `[${fieldList}${extra}]. It has been in ${loaded.status} since ` +
        `${loaded.createdAtIso}. Please complete or close the draft.`,
      tenantId: input.tenantId,
    });
    if (!post.delivered) return { dispatched: false, outcomeCode: 'provider-not-delivered' };

    const marked = await markMissingFieldsReminderSent({
      actor,
      homeId: input.homeId,
      incidentId: input.incidentId,
      tenantId: input.tenantId,
    });
    return {
      dispatched: marked.recorded,
      ...(marked.recorded ? {} : { outcomeCode: 'reminder-already-recorded' as const }),
    };
  } catch {
    throw new Error('Missing fields delivery processing failed.');
  }
}

export function createStartMissingFieldsSweepActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartMissingFieldsSweepInput) => Promise<string> {
  return (_context, input) =>
    start(
      client,
      MISSING_FIELDS_SWEEP_ORCHESTRATOR,
      {
        correlationId: input.correlationId,
        minAgeMinutes: input.minAgeMinutes,
        scheduledForIso: input.scheduledForIso,
      },
      input.sweepInstanceId,
    );
}

export function createStartMissingFieldsDeliveryActivity(
  client: DurableOrchestrationStarter,
): (context: ActivityContext, input: StartMissingFieldsDeliveryInput) => Promise<string> {
  return (_context, input) =>
    start(
      client,
      SEND_MISSING_FIELDS_ORCHESTRATOR,
      {
        correlationId: input.correlationId,
        homeId: input.homeId,
        incidentId: input.incidentId,
        tenantId: input.tenantId,
      },
      input.deliveryInstanceId,
    );
}

function start(
  client: DurableOrchestrationStarter,
  orchestrator: string,
  input: unknown,
  instanceId: string,
): Promise<string> {
  assertDurableInstanceId(instanceId);
  assertDurablePayload(input, orchestrator);
  return scheduleDurableOrchestrationIdempotently(client, orchestrator, input, {
    instanceId,
    version: MISSING_FIELDS_ORCHESTRATION_VERSION,
  });
}
