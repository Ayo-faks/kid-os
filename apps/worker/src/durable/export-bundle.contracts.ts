import type { SeriousIncidentExportWorkflowInput } from '@careos/contracts';
import {
  SERIOUS_INCIDENT_EXPORT_DURABLE_VERSION,
  SERIOUS_INCIDENT_EXPORT_DURABLE_WORKFLOW_TYPE,
  seriousIncidentExportWorkflowId,
} from '@careos/contracts';

import { assertDurableInstanceId } from './payload-policy.js';

export const EXPORT_BUNDLE_ORCHESTRATION_VERSION = SERIOUS_INCIDENT_EXPORT_DURABLE_VERSION;
export const SERIOUS_INCIDENT_EXPORT_ORCHESTRATOR = SERIOUS_INCIDENT_EXPORT_DURABLE_WORKFLOW_TYPE;
export const PROCESS_EXPORT_BUNDLE_ACTIVITY = 'processSeriousIncidentExportActivityV1';

export type SeriousIncidentExportOrchestratorInput = SeriousIncidentExportWorkflowInput;

export interface DurableExportBundleResult {
  readonly bundleId: string;
  readonly outcomeCode?: 'bundle-build-failed';
  readonly status: 'ready' | 'failed';
}

export function exportBundleInstanceId(bundleId: string): string {
  return assertDurableInstanceId(seriousIncidentExportWorkflowId(bundleId));
}
