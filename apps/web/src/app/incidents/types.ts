export interface IncidentListItem {
  readonly id: string;
  readonly status: string;
  readonly residentId: string;
  readonly residentName: string;
  readonly templateId: string;
  readonly templateTitle: string;
  readonly currentVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IncidentDetail {
  readonly id: string;
  readonly workflowId: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly residentId: string;
  readonly residentName: string;
  readonly authorUserId: string;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly exportedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly formTemplate: {
    readonly templateId: string;
    readonly title: string;
    readonly version: string;
  };
  readonly approval: {
    readonly id: string;
    readonly status: 'pending' | 'approved' | 'rejected';
    readonly requiredRoles: readonly ('manager' | 'safeguarding_lead')[];
    readonly coveredRoles: readonly ('manager' | 'safeguarding_lead')[];
    readonly missingRoles: readonly ('manager' | 'safeguarding_lead')[];
    readonly signaturesRequired: 1 | 2;
    readonly signaturesRecorded: number;
    readonly signedByUserIds: readonly string[];
    readonly signedRoles: readonly string[];
  } | null;
  readonly exportBundle: {
    readonly id: string;
    readonly status: 'pending' | 'building' | 'ready' | 'failed';
    readonly sizeBytes: number | null;
    readonly failureReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  } | null;
  readonly versions: ReadonlyArray<{
    readonly version: number;
    readonly status: string;
    readonly formData: Record<string, unknown>;
    readonly missingMandatory: readonly string[];
    readonly validationErrors: unknown;
    readonly actorKind: string;
    readonly actorUserId: string | null;
    readonly createdAt: string;
  }>;
  readonly timeline: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly occurredAt: string;
    readonly summary: string;
    readonly actorKind: string;
  }>;
}
