// Phase 4 §2 — Serious incident export bundle activity contracts.

import type { IncidentActor } from './incidents-workflow.js';

export const EXPORT_BUNDLES_TASK_QUEUE = 'careos.export-bundles';
export const SERIOUS_INCIDENT_EXPORT_WORKFLOW_TYPE = 'SeriousIncidentExportWorkflow';
export const SERIOUS_INCIDENT_EXPORT_DURABLE_WORKFLOW_TYPE = 'SeriousIncidentExportOrchestratorV1';
export const SERIOUS_INCIDENT_EXPORT_DURABLE_VERSION = '1.0.0';

export function seriousIncidentExportWorkflowId(bundleId: string): string {
  return `serious-incident-export-${bundleId}`;
}

export interface SeriousIncidentExportWorkflowInput {
  readonly bundleId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly actor: IncidentActor;
}

export interface BundleManifest {
  readonly bundleId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly createdAt: string;
  readonly files: ReadonlyArray<{
    readonly name: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }>;
  readonly signatureAlgorithm: string;
}

export interface MarkExportBundleBuildingInput {
  readonly bundleId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly actor: IncidentActor;
}

export interface ComposeExportBundleInput {
  readonly bundleId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly actor: IncidentActor;
}

export interface ComposeExportBundleResult {
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly manifestSha256: string;
  readonly signature: string;
  readonly signatureAlgorithm: string;
  readonly retainUntilIso: string;
}

export interface MarkExportBundleReadyInput {
  readonly bundleId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly manifestSha256: string;
  readonly signature: string;
  readonly signatureAlgorithm: string;
  readonly retainUntilIso: string;
  readonly actor: IncidentActor;
}

export interface MarkExportBundleFailedInput {
  readonly bundleId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly reason: string;
  readonly actor: IncidentActor;
}

export interface MarkExportBundleResult {
  readonly transitioned: boolean;
}
