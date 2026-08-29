import type { ApprovalRole } from '@careos/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const uuid = z.string().uuid();

// The API accepts a JSON object so drafts may be incomplete, then validates all
// provided values against the selected JSON Schema before Temporal. The worker
// performs full required-field validation before persistence/approval.
const formData = z.record(z.string(), z.unknown());

export const CreateIncidentSchema = z.object({
  residentId: uuid,
  formTemplate: z.object({
    templateId: z.string().min(1).max(200),
    version: z.string().min(1).max(50),
  }),
  initialFormData: formData.optional(),
});
export class CreateIncidentDto extends createZodDto(CreateIncidentSchema) {}

export const DraftIncidentFromTextSchema = z.object({
  free_text: z.string().min(1).max(8000),
  resident_id: uuid,
  template_id: z.string().min(1).max(200),
});
export class DraftIncidentFromTextDto extends createZodDto(DraftIncidentFromTextSchema) {}

export interface DraftIncidentFromTextResponse {
  readonly confidence: number;
  readonly form_data: Record<string, unknown>;
  readonly missing_mandatory: readonly string[];
}

export const UpdateIncidentSchema = z.object({
  formData,
});
export class UpdateIncidentDto extends createZodDto(UpdateIncidentSchema) {}

export const SubmitIncidentSchema = z.object({}).strict();
export class SubmitIncidentDto extends createZodDto(SubmitIncidentSchema) {}

export const ApproveIncidentSchema = z.object({
  note: z.string().max(1000).optional(),
});
export class ApproveIncidentDto extends createZodDto(ApproveIncidentSchema) {}

export const ExportIncidentSchema = z.object({}).strict();
export class ExportIncidentDto extends createZodDto(ExportIncidentSchema) {}

export interface IncidentResponse {
  readonly id: string;
  readonly workflowId: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly residentId: string;
  readonly authorUserId: string;
  readonly approvedByUserId: string | null;
  readonly approvedAt: string | null;
  readonly exportedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IncidentListItemResponse {
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

export interface IncidentListResponse {
  readonly items: readonly IncidentListItemResponse[];
}

export interface IncidentApprovalProgressResponse {
  readonly id: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly requiredRoles: readonly ApprovalRole[];
  readonly coveredRoles: readonly ApprovalRole[];
  readonly missingRoles: readonly ApprovalRole[];
  readonly signaturesRequired: 1 | 2;
  readonly signaturesRecorded: number;
  readonly signedByUserIds: readonly string[];
  readonly signedRoles: readonly string[];
}

export interface IncidentExportBundleResponse {
  readonly id: string;
  readonly status: 'pending' | 'building' | 'ready' | 'failed';
  readonly sizeBytes: number | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IncidentVersionResponse {
  readonly version: number;
  readonly status: string;
  readonly formData: Record<string, unknown>;
  readonly missingMandatory: readonly string[];
  readonly validationErrors: unknown;
  readonly actorKind: string;
  readonly actorUserId: string | null;
  readonly createdAt: string;
}

export interface TimelineEntryResponse {
  readonly id: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly incidentId: string | null;
  readonly taskId: string | null;
  readonly actorKind: string;
  readonly actorUserId: string | null;
}

export interface IncidentDetailResponse extends IncidentResponse {
  readonly residentName: string;
  readonly formTemplate: {
    readonly templateId: string;
    readonly title: string;
    readonly version: string;
  };
  readonly approval: IncidentApprovalProgressResponse | null;
  readonly exportBundle: IncidentExportBundleResponse | null;
  readonly versions: readonly IncidentVersionResponse[];
  readonly timeline: readonly TimelineEntryResponse[];
}

export interface CreateIncidentResponse {
  readonly id: string;
  readonly workflowId: string;
  readonly status: 'draft';
}
