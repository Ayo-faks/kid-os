// Phase 3 §2 (D3 slice 5) — missing-mandatory-fields audit activities.

export interface FindIncidentsMissingMandatoryFieldsInput {
  readonly nowIso: string;
  readonly minAgeMinutes: number;
  readonly correlationId: string;
}

export interface IncidentMissingFields {
  readonly tenantId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly residentId: string;
  readonly createdAtIso: string;
  readonly missingFields: readonly string[];
}

export interface FindIncidentsMissingMandatoryFieldsResult {
  readonly incidents: readonly IncidentMissingFields[];
}

export interface MissingFieldsAuditActor {
  readonly correlationId: string;
  readonly kind: 'system';
  readonly userId: null;
}

export interface LoadMissingFieldsContextInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly actor: MissingFieldsAuditActor;
}

export interface MissingFieldsContext {
  readonly incidentId: string;
  readonly residentId: string;
  readonly createdAtIso: string;
  readonly missingFields: readonly string[];
  readonly alreadyReminded: boolean;
  readonly status: string;
}

export interface MarkMissingFieldsReminderSentInput {
  readonly tenantId: string;
  readonly homeId: string;
  readonly incidentId: string;
  readonly actor: MissingFieldsAuditActor;
}

export interface MarkMissingFieldsReminderSentResult {
  readonly recorded: boolean;
}
