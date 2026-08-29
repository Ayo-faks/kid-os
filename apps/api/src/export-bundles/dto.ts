import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RequestExportBundleSchema = z
  .object({
    incident_id: z.string().uuid(),
  })
  .strict();

export class RequestExportBundleDto extends createZodDto(RequestExportBundleSchema) {}

export interface RequestExportBundleResponse {
  readonly id: string;
  readonly workflowId: string;
  readonly status: 'pending' | 'building' | 'ready' | 'failed';
}

export interface ExportBundleDownloadResponse {
  readonly url: string;
  readonly expiresAt: string;
}

export interface ExportBundleResponse {
  readonly id: string;
  readonly incidentId: string;
  readonly status: 'pending' | 'building' | 'ready' | 'failed';
  readonly objectKey: string | null;
  readonly manifestSha256: string | null;
  readonly signature: string | null;
  readonly signatureAlgorithm: string | null;
  readonly sizeBytes: number | null;
  readonly retainUntil: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
