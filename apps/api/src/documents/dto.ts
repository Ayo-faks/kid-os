import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'text/markdown',
  'text/plain',
] as const;
export const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024;

const DocumentUploadMetadataSchema = z.object({
  original_filename: z.string().min(1).max(512),
  mime_type: z.enum(DOCUMENT_MIME_TYPES),
  size_bytes: z.number().int().positive().max(MAX_DOCUMENT_SIZE_BYTES),
});

export const PresignDocumentSchema = DocumentUploadMetadataSchema.strict();
export class PresignDocumentDto extends createZodDto(PresignDocumentSchema) {}

export const RegisterDocumentSchema = DocumentUploadMetadataSchema.extend({
  object_key: z.string().min(1).max(1024),
}).strict();
export class RegisterDocumentDto extends createZodDto(RegisterDocumentSchema) {}

export interface PresignDocumentResponse {
  readonly objectKey: string;
  readonly uploadUrl: string;
}

export interface RegisterDocumentResponse {
  readonly id: string;
  readonly workflowId: string;
  readonly status: 'processing';
}

export interface DocumentResponse {
  readonly id: string;
  readonly objectKey: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly status: 'uploaded' | 'extracting' | 'extracted' | 'failed';
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentListResponse {
  readonly documents: readonly DocumentResponse[];
}
