// Activity contracts for the IncidentReportWorkflow (Phase 1 §5).
// Worker and api share these so the api can later invoke activities (eg via
// signals it forwards) and tests can mock with the same types.

import type { ApprovalRole, ApprovalLevel } from './approval-policy.js';
import type { IncidentActor, IncidentStatus } from './incidents-workflow.js';

export interface FormTemplateRefDescriptor {
  readonly templateId: string;
  readonly version: string;
}

// 1. draftIncidentFromText — llm-gateway extract-structured. Never auto-submits.
export interface DraftFromTextInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly residentId: string;
  readonly formTemplate: FormTemplateRefDescriptor;
  readonly narrative: string;
  readonly correlationId: string;
  readonly agentRunId?: string;
}

export interface DraftFromTextResult {
  readonly formData: Record<string, unknown>;
  readonly missingMandatory: readonly string[];
  readonly confidence: number;
  readonly promptHash: string;
}

// 2. validateAgainstSchema — local Ajv/JSON-Schema check.
export interface ValidateAgainstSchemaInput {
  readonly formTemplate: FormTemplateRefDescriptor;
  readonly formData: Record<string, unknown>;
}

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export interface ValidateAgainstSchemaResult {
  readonly valid: boolean;
  readonly missingMandatory: readonly string[];
  readonly errors: readonly ValidationError[];
}

export interface ResolveIncidentApprovalRequirementInput {
  readonly formTemplate: FormTemplateRefDescriptor;
  readonly formData: Readonly<Record<string, unknown>>;
}

export interface ResolveIncidentApprovalRequirementResult {
  readonly immediateRisk: boolean;
  readonly level: ApprovalLevel;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly safeguarding: boolean;
  readonly signaturesRequired: 1 | 2;
}

// 3. persistIncidentVersion — writes core.incident_versions (and bootstraps
// core.incidents on version 1). RLS GUCs are set per-transaction so audit
// triggers attribute the row to the right actor.
export interface PersistIncidentVersionInput {
  readonly incidentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly residentId: string;
  readonly formTemplate: FormTemplateRefDescriptor;
  readonly version: number;
  readonly status: IncidentStatus;
  readonly formData: Record<string, unknown>;
  readonly missingMandatory: readonly string[];
  readonly validationErrors: readonly ValidationError[];
  readonly authorUserId: string;
  readonly workflowId: string;
  readonly actor: IncidentActor;
}

export interface PersistIncidentVersionResult {
  readonly versionId: string;
  readonly version: number;
}

// 4. routeForApproval — flips incident.status to awaiting_approval and emits a
// timeline entry. Approval gating is enforced by the controller (RolesGuard).
export interface RouteForApprovalInput {
  readonly incidentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly residentId: string;
  readonly version: number;
  readonly immediateRisk: boolean;
  readonly safeguarding: boolean;
  readonly actor: IncidentActor;
}

// 5. exportPdf — render the approved incident via Gotenberg and store in MinIO.
export interface ExportPdfInput {
  readonly incidentId: string;
  readonly tenantId: string;
  readonly homeId: string;
  readonly residentId: string;
  readonly version: number;
  readonly formTemplate: FormTemplateRefDescriptor;
  readonly formData: Record<string, unknown>;
  readonly actor: IncidentActor;
}

export interface ExportPdfResult {
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

// 6. writeAuditEvent — append-only workflow-lifecycle events that aren't
// captured by the DB triggers (agent run boundaries, approval routed, export
// attempted/failed).
export interface WriteAuditEventInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly residentId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly actor: IncidentActor;
}
