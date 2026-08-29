import { createHash } from 'node:crypto';

import type {
  DispatchEmailDraftNotificationsInput,
  DispatchEmailDraftNotificationsResult,
  DraftEmailInput,
  DraftEmailResult,
  EmailDraftStatus,
  EmailSensitivity,
  PersistEmailDraftInput,
  PersistEmailDraftResult,
  ValidateEmailDraftInput,
  ValidateEmailDraftResult,
} from '@careos/contracts';
import { validateFormData } from '@careos/schemas';

import { withTenantContext } from '../db/pg.js';

import { callHermesTool } from './hermes.js';

interface HermesDraftEmailResult {
  readonly confidence?: number;
  readonly form_data?: Record<string, unknown>;
  readonly missing_mandatory?: readonly string[];
  readonly refused?: boolean;
  readonly [key: string]: unknown;
}

export async function draftEmail(input: DraftEmailInput): Promise<DraftEmailResult> {
  const promptHash = sha256(
    JSON.stringify({
      instructions: input.instructions,
      recipient: input.recipient,
      source: input.source,
    }),
  );

  const json = await callHermesTool<HermesDraftEmailResult>(
    'draft_email',
    {
      correlation_id: input.correlationId,
      instructions: input.instructions,
      recipient: {
        email: input.recipient.email,
        ...(input.recipient.name !== undefined ? { name: input.recipient.name } : {}),
        ...(input.recipient.role !== undefined ? { role: input.recipient.role } : {}),
      },
      source: {
        kind: input.source.kind,
        summary: input.source.summary,
        ...(input.source.id !== undefined ? { id: input.source.id } : {}),
      },
    },
    {
      correlationId: input.correlationId,
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
  );

  const refused = json.refused === true;
  const rawFormData = isRecord(json.form_data) ? json.form_data : {};
  const subject = readString(rawFormData.subject);
  const body = readString(rawFormData.body);
  const sensitivity = coerceSensitivity(rawFormData.sensitivity, refused);
  const sensitivityReasons = readStringList(rawFormData.sensitivity_reasons);

  const formData: Record<string, unknown> = refused
    ? {}
    : {
        body,
        recipient: {
          email: input.recipient.email,
          ...(input.recipient.name !== undefined ? { name: input.recipient.name } : {}),
          ...(input.recipient.role !== undefined ? { role: input.recipient.role } : {}),
        },
        sensitivity,
        sensitivity_reasons: sensitivityReasons,
        subject,
      };

  return {
    body,
    confidence: refused ? 0 : coerceConfidence(json.confidence),
    formData,
    missingMandatory: Array.isArray(json.missing_mandatory) ? json.missing_mandatory : [],
    promptHash,
    refused,
    sensitivity,
    sensitivityReasons,
    subject,
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- activity contract requires Promise return
export async function validateEmailDraft(
  input: ValidateEmailDraftInput,
): Promise<ValidateEmailDraftResult> {
  return validateFormData('comms.email-draft', 'v1', input.formData);
}

export async function persistEmailDraft(
  input: PersistEmailDraftInput,
): Promise<PersistEmailDraftResult> {
  return withTenantContext(
    {
      actor: {
        agentRunId: input.actor.agentRunId,
        correlationId: input.actor.correlationId,
        kind: input.actor.kind,
        promptHash: input.actor.promptHash,
        userId: input.actor.userId,
      },
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      const existing = await client.query<{ readonly status: EmailDraftStatus }>(
        `SELECT status FROM core.email_drafts WHERE id = $1::uuid LIMIT 1`,
        [input.emailDraftId],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        const row = existing.rows[0];
        if (row) {
          return {
            emailDraftId: input.emailDraftId,
            sensitivity: input.sensitivity,
            status: row.status,
          };
        }
      }

      await client.query(
        `INSERT INTO core.email_drafts (
           id, tenant_id, home_id, workflow_id, source_kind, source_id, source_summary,
           recipient_name, recipient_email, recipient_role, subject, body,
           sensitivity, sensitivity_reasons, status, prompt_hash, created_by_user_id,
           created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4,
           $5::"core"."EmailSourceKind", $6::uuid, $7,
           $8, $9, $10, $11, $12,
           $13::"core"."EmailSensitivity", $14::jsonb,
           $15::"core"."EmailDraftStatus", $16, $17::uuid,
           now(), now()
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          input.emailDraftId,
          input.tenantId,
          input.homeId,
          input.workflowId,
          input.source.kind,
          input.source.id ?? null,
          input.source.summary,
          input.recipient.name ?? null,
          input.recipient.email,
          input.recipient.role ?? null,
          input.subject,
          input.body,
          input.sensitivity,
          JSON.stringify(input.sensitivityReasons),
          input.status,
          input.actor.promptHash ?? null,
          input.authorUserId,
        ],
      );

      return {
        emailDraftId: input.emailDraftId,
        sensitivity: input.sensitivity,
        status: input.status,
      };
    },
  );
}

export async function dispatchEmailDraftNotifications(
  input: DispatchEmailDraftNotificationsInput,
): Promise<DispatchEmailDraftNotificationsResult> {
  if ((process.env.NOVU_PROVIDER ?? 'stub') === 'disabled') {
    return { dispatched: false };
  }

  // Phase 2 §2: drafts are never sent. We only queue a safe in-app review
  // notification for sensitive drafts via the outbox stub.
  if (input.sensitivity !== 'sensitive' || input.status !== 'needs_review') {
    return { dispatched: false };
  }

  const outboxId = input.emailDraftId;
  await withTenantContext(
    {
      actor: {
        agentRunId: input.actor.agentRunId,
        correlationId: input.actor.correlationId,
        kind: input.actor.kind,
        promptHash: input.actor.promptHash,
        userId: input.actor.userId,
      },
      homeId: input.homeId,
      tenantId: input.tenantId,
    },
    async (client) => {
      await client.query(
        `INSERT INTO core.outbox
           (id, tenant_id, home_id, topic, payload, status, attempts, available_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'novu.email_draft.needs_review', $4::jsonb,
           'pending', 0, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [
          outboxId,
          input.tenantId,
          input.homeId,
          JSON.stringify({
            emailDraftId: input.emailDraftId,
            sensitivity: input.sensitivity,
            status: input.status,
          }),
        ],
      );
    },
  );

  return { dispatched: true, outboxId };
}

function coerceSensitivity(value: unknown, refused: boolean): EmailSensitivity {
  if (refused) {
    return 'sensitive';
  }
  return value === 'sensitive' ? 'sensitive' : 'routine';
}

function coerceConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return 0;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    typeof entry === 'string' && entry.trim() !== '' ? [entry.trim()] : [],
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
