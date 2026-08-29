import type { ExportPdfInput } from '@careos/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createGotenbergConverter,
  createMinioStore,
  exportBucketName,
  objectKeyFor,
  renderIncidentHtml,
  sha256Hex,
} from './export-pdf.js';

const INPUT: ExportPdfInput = {
  actor: {
    correlationId: 'corr-1',
    kind: 'user',
    userId: '99999999-9999-4999-8999-999999999999',
  },
  formData: {
    behaviourType: 'verbal_aggression',
    location: 'lounge',
    notes: '<script>alert(1)</script>',
    summary: 'verbal escalation',
  },
  formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '33333333-3333-4333-8333-333333333333',
  residentId: '44444444-4444-4444-8444-444444444444',
  tenantId: '11111111-1111-4111-8111-111111111111',
  version: 2,
};

describe('export-pdf helpers', () => {
  it('objectKeyFor is deterministic and tenant/incident/version scoped', () => {
    expect(objectKeyFor(INPUT)).toBe(
      `incidents/${INPUT.tenantId}/${INPUT.incidentId}/v${INPUT.version}.pdf`,
    );
  });

  it('renderIncidentHtml escapes user-supplied form values', () => {
    const { html, title } = renderIncidentHtml(INPUT);
    expect(title).toContain(INPUT.incidentId);
    expect(html).toContain('verbal escalation');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain(INPUT.formTemplate.templateId);
  });

  it('sha256Hex matches the standard sha256 of the buffer', () => {
    const buf = Buffer.from('hello world');
    expect(sha256Hex(buf)).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('exportBucketName honours MINIO_INCIDENTS_BUCKET override', () => {
    const original = process.env.MINIO_INCIDENTS_BUCKET;
    process.env.MINIO_INCIDENTS_BUCKET = 'custom-bucket';
    try {
      expect(exportBucketName()).toBe('custom-bucket');
    } finally {
      if (original === undefined) {
        delete process.env.MINIO_INCIDENTS_BUCKET;
      } else {
        process.env.MINIO_INCIDENTS_BUCKET = original;
      }
    }
  });
});

describe('createGotenbergConverter', () => {
  it('POSTs multipart to /forms/chromium/convert/html and returns the PDF body', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fetchImpl = vi.fn((input: URL | string | Request, init?: RequestInit) => {
      const url =
        input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
      expect(url.pathname).toBe('/forms/chromium/convert/html');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      return Promise.resolve(new Response(pdfBytes, { status: 200 }));
    });

    const converter = createGotenbergConverter('http://gotenberg.test:3000', fetchImpl);
    const buf = await converter.htmlToPdf('<p>hi</p>');
    expect(buf.equals(Buffer.from(pdfBytes))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws a descriptive error when Gotenberg returns a non-2xx status', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('boom', { status: 503, statusText: 'Service Unavailable' })),
    );
    const converter = createGotenbergConverter('http://gotenberg.test:3000', fetchImpl);
    await expect(converter.htmlToPdf('<p>x</p>')).rejects.toThrow(/503 Service Unavailable/);
  });
});

describe('createMinioStore', () => {
  it('creates the bucket on first put and reuses the cached check afterwards', async () => {
    const fakeClient = {
      bucketExists: vi.fn(() => Promise.resolve(false)),
      makeBucket: vi.fn(() => Promise.resolve()),
      putObject: vi.fn(() => Promise.resolve()),
    } as const;

    const store = createMinioStore(fakeClient as never);
    await store.ensureBucket('careos-incidents');
    await store.ensureBucket('careos-incidents');
    await store.putObject('careos-incidents', 'key.pdf', Buffer.from('abc'), 'application/pdf');

    expect(fakeClient.bucketExists).toHaveBeenCalledTimes(1);
    expect(fakeClient.makeBucket).toHaveBeenCalledTimes(1);
    expect(fakeClient.putObject).toHaveBeenCalledWith(
      'careos-incidents',
      'key.pdf',
      Buffer.from('abc'),
      3,
      { 'Content-Type': 'application/pdf' },
    );
  });
});
