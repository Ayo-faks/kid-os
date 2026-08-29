import { describe, expect, it } from 'vitest';

import { PresignDocumentSchema, RegisterDocumentSchema } from './dto.js';

const validDocument = {
  mime_type: 'application/pdf',
  original_filename: 'Care plan.pdf',
  size_bytes: 128,
};

describe('document upload schemas', () => {
  it('accepts a supported document within the upload limit', () => {
    expect(PresignDocumentSchema.safeParse(validDocument).success).toBe(true);
    expect(
      RegisterDocumentSchema.safeParse({
        ...validDocument,
        object_key: 'tenants/t/homes/h/documents/id/Care-plan.pdf',
      }).success,
    ).toBe(true);
  });

  it('rejects executable content types', () => {
    expect(
      PresignDocumentSchema.safeParse({ ...validDocument, mime_type: 'application/x-msdownload' })
        .success,
    ).toBe(false);
  });

  it('rejects empty files and files larger than 25 MiB', () => {
    expect(PresignDocumentSchema.safeParse({ ...validDocument, size_bytes: 0 }).success).toBe(
      false,
    );
    expect(
      PresignDocumentSchema.safeParse({ ...validDocument, size_bytes: 25 * 1024 * 1024 + 1 })
        .success,
    ).toBe(false);
  });
});
