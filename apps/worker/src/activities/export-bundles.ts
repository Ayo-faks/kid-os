// Phase 4 §2 — Serious incident export bundle activities.
//
// Activities are race-safe conditional UPDATEs against `core.export_bundles`
// so workflow retries are idempotent. `composeExportBundle` assembles a
// manifest (incident JSON + audit trail JSON), HMAC-signs it with
// `EXPORT_BUNDLE_SIGNING_KEY`, and uploads a ZIP to MinIO.

import { createHash, createHmac } from 'node:crypto';

import type {
  ComposeExportBundleInput,
  ComposeExportBundleResult,
  MarkExportBundleBuildingInput,
  MarkExportBundleFailedInput,
  MarkExportBundleReadyInput,
  MarkExportBundleResult,
} from '@careos/contracts';
import { zipSync, strToU8 } from 'fflate';

import { withTenantContext } from '../db/pg.js';
import {
  bundleBucketName,
  createBundleStore,
  isMinioConfigured,
  type BundleObjectStore,
} from '../storage/bundle-store.js';

import {
  createGotenbergConverter,
  type GotenbergConverter,
  renderIncidentHtml,
} from './export-pdf.js';

// Injectable for tests; defaults to MinIO-backed store.
let bundleStoreOverride: BundleObjectStore | undefined;
export function __setBundleStoreForTests(store: BundleObjectStore | undefined): void {
  bundleStoreOverride = store;
}

let bundlePdfConverterOverride: GotenbergConverter | undefined;
export function __setBundlePdfConverterForTests(converter: GotenbergConverter | undefined): void {
  bundlePdfConverterOverride = converter;
}

const RETENTION_YEARS = 7;
const SIGNATURE_ALG = 'HMAC-SHA256';

export async function markExportBundleBuilding(
  input: MarkExportBundleBuildingInput,
): Promise<MarkExportBundleResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query(
        `UPDATE core.export_bundles
            SET status = 'building',
                updated_at = NOW()
          WHERE id = $1::uuid
            AND status = 'pending'`,
        [input.bundleId],
      );
      return { transitioned: (result.rowCount ?? 0) > 0 };
    },
  );
}

export async function composeExportBundle(
  input: ComposeExportBundleInput,
): Promise<ComposeExportBundleResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const incidentRows = await client.query<{
        readonly id: string;
        readonly resident_id: string | null;
        readonly status: string;
        readonly current_version: number;
        readonly created_at: Date;
        readonly form_data: unknown;
        readonly template_id: string;
        readonly template_version: string;
        readonly missing_mandatory: unknown;
      }>(
        `SELECT i.id::text AS id, i.resident_id::text AS resident_id,
                i.status::text AS status, i.current_version AS current_version,
                i.created_at AS created_at,
                 v.form_data AS form_data, v.missing_mandatory AS missing_mandatory,
                 ft.template_id AS template_id, ft.version AS template_version
           FROM core.incidents i
           JOIN core.incident_versions v
             ON v.incident_id = i.id AND v.version = i.current_version
               JOIN core.form_templates ft ON ft.id = i.form_template_id
          WHERE i.id = $1::uuid
          LIMIT 1`,
        [input.incidentId],
      );
      const incident = incidentRows.rows[0];
      if (incident === undefined) {
        throw new Error(`export-bundle: incident ${input.incidentId} not found`);
      }

      const auditRows = await client.query<{
        readonly id: string;
        readonly occurred_at: Date;
        readonly action: string;
        readonly subject_type: string;
        readonly subject_id: string | null;
        readonly actor_kind: string;
        readonly actor_user_id: string | null;
        readonly correlation_id: string | null;
        readonly diff: unknown;
      }>(
        `SELECT id::text AS id,
                occurred_at,
                action,
                subject_type,
                subject_id::text AS subject_id,
                actor_kind,
                actor_user_id::text AS actor_user_id,
                correlation_id,
                diff
           FROM audit.events
          WHERE tenant_id = $1::uuid
            AND home_id = $2::uuid
            AND (
              (subject_type = 'incident' AND subject_id = $3::uuid)
              OR (subject_type = 'export_bundle' AND subject_id = $4::uuid)
            )
          ORDER BY occurred_at ASC`,
        [input.tenantId, input.homeId, input.incidentId, input.bundleId],
      );

      const incidentJson = JSON.stringify(incident, null, 2);
      const auditJson = JSON.stringify(auditRows.rows, null, 2);
      const formData = isRecord(incident.form_data) ? incident.form_data : {};
      const { html } = renderIncidentHtml({
        actor: input.actor,
        formData,
        formTemplate: {
          templateId: incident.template_id,
          version: incident.template_version,
        },
        homeId: input.homeId,
        incidentId: input.incidentId,
        residentId: incident.resident_id ?? 'unknown',
        tenantId: input.tenantId,
        version: incident.current_version,
      });
      const incidentPdf = await (
        bundlePdfConverterOverride ?? createGotenbergConverter()
      ).htmlToPdf(html);
      const incidentSha = sha256Hex(incidentJson);
      const auditSha = sha256Hex(auditJson);
      const pdfSha = sha256BufferHex(incidentPdf);

      const manifest = {
        bundleId: input.bundleId,
        createdAt: new Date().toISOString(),
        files: [
          {
            name: 'incident.json',
            sha256: incidentSha,
            sizeBytes: Buffer.byteLength(incidentJson, 'utf8'),
          },
          {
            name: 'audit-trail.json',
            sha256: auditSha,
            sizeBytes: Buffer.byteLength(auditJson, 'utf8'),
          },
          {
            name: 'incident.pdf',
            sha256: pdfSha,
            sizeBytes: incidentPdf.length,
          },
        ],
        homeId: input.homeId,
        incidentId: input.incidentId,
        signatureAlgorithm: SIGNATURE_ALG,
        tenantId: input.tenantId,
      };
      const manifestJson = JSON.stringify(manifest, null, 2);
      const manifestSha256 = sha256Hex(manifestJson);

      const signingKey = process.env.EXPORT_BUNDLE_SIGNING_KEY ?? '';
      if (signingKey === '' || signingKey === 'change-me') {
        throw new Error('export-bundle: EXPORT_BUNDLE_SIGNING_KEY is not configured');
      }
      const signature = createHmac('sha256', signingKey).update(manifestSha256).digest('hex');

      const objectKey = `tenants/${input.tenantId}/incidents/${input.incidentId}/bundles/${input.bundleId}.zip`;

      const zipBuffer = Buffer.from(
        zipSync({
          'audit-trail.json': strToU8(auditJson),
          'incident.json': strToU8(incidentJson),
          'incident.pdf': incidentPdf,
          'manifest.json': strToU8(manifestJson),
          'signature.txt': strToU8(`${SIGNATURE_ALG} ${signature}\n`),
        }),
      );

      let sizeBytes: number;
      if (isMinioConfigured()) {
        const store = bundleStoreOverride ?? createBundleStore();
        const bucket = bundleBucketName();
        await store.ensureBucket(bucket);
        await store.putObject(bucket, objectKey, zipBuffer, 'application/zip');
        sizeBytes = zipBuffer.length;
      } else {
        // Disabled mode (MINIO_DISABLED=true): keep deterministic size from
        // raw payload bytes so tests / dev installs without a MinIO daemon
        // still get a stable manifest entry.
        sizeBytes =
          Buffer.byteLength(incidentJson, 'utf8') +
          Buffer.byteLength(auditJson, 'utf8') +
          incidentPdf.length +
          Buffer.byteLength(manifestJson, 'utf8');
      }

      const retainUntilIso = new Date(
        Date.now() + RETENTION_YEARS * 365 * 24 * 60 * 60 * 1000,
      ).toISOString();

      return {
        manifestSha256,
        objectKey,
        retainUntilIso,
        signature,
        signatureAlgorithm: SIGNATURE_ALG,
        sizeBytes,
      };
    },
  );
}

export async function markExportBundleReady(
  input: MarkExportBundleReadyInput,
): Promise<MarkExportBundleResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query(
        `UPDATE core.export_bundles
            SET status = 'ready',
                object_key = $2,
                size_bytes = $3,
                manifest_sha256 = $4,
                signature = $5,
                signature_algorithm = $6,
                retain_until = $7::timestamptz,
                updated_at = NOW()
          WHERE id = $1::uuid
            AND status = 'building'`,
        [
          input.bundleId,
          input.objectKey,
          input.sizeBytes,
          input.manifestSha256,
          input.signature,
          input.signatureAlgorithm,
          input.retainUntilIso,
        ],
      );
      return { transitioned: (result.rowCount ?? 0) > 0 };
    },
  );
}

export async function markExportBundleFailed(
  input: MarkExportBundleFailedInput,
): Promise<MarkExportBundleResult> {
  return withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query(
        `UPDATE core.export_bundles
            SET status = 'failed',
                failure_reason = $2,
                updated_at = NOW()
          WHERE id = $1::uuid
            AND status IN ('pending', 'building')`,
        [input.bundleId, input.reason.slice(0, 500)],
      );
      return { transitioned: (result.rowCount ?? 0) > 0 };
    },
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256BufferHex(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
