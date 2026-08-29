// Phase 3 §2 (D3 slice 5) — missing-mandatory-fields audit activities.

import type {
  FindIncidentsMissingMandatoryFieldsInput,
  FindIncidentsMissingMandatoryFieldsResult,
  IncidentMissingFields,
  LoadMissingFieldsContextInput,
  MarkMissingFieldsReminderSentInput,
  MarkMissingFieldsReminderSentResult,
  MissingFieldsContext,
} from '@careos/contracts';

import { withSystemContext, withTenantContext } from '../db/pg.js';

interface IncidentRow {
  readonly tenant_id: string;
  readonly home_id: string;
  readonly id: string;
  readonly resident_id: string;
  readonly created_at: Date;
  readonly missing_mandatory: string[] | null;
}

export async function findIncidentsMissingMandatoryFields(
  input: FindIncidentsMissingMandatoryFieldsInput,
): Promise<FindIncidentsMissingMandatoryFieldsResult> {
  const cutoff = new Date(new Date(input.nowIso).getTime() - input.minAgeMinutes * 60_000);

  const rows = await withSystemContext({ correlationId: input.correlationId }, async (client) => {
    const result = await client.query<IncidentRow>(
      `SELECT i.id,
                i.tenant_id,
                i.home_id,
                i.resident_id,
                i.created_at,
                v.missing_mandatory
           FROM core.incidents i
           JOIN core.incident_versions v
             ON v.incident_id = i.id
            AND v.version     = i.current_version
          WHERE i.missing_fields_reminder_sent_at IS NULL
            AND i.created_at <= $1
            AND i.status IN ('draft', 'awaiting_fields')
            AND COALESCE(array_length(v.missing_mandatory, 1), 0) > 0
          ORDER BY i.created_at ASC, i.id ASC
          LIMIT 200`,
      [cutoff.toISOString()],
    );
    return result.rows;
  });

  const incidents: IncidentMissingFields[] = rows.map((row) => ({
    createdAtIso: row.created_at.toISOString(),
    homeId: row.home_id,
    incidentId: row.id,
    missingFields: row.missing_mandatory ?? [],
    residentId: row.resident_id,
    tenantId: row.tenant_id,
  }));

  return { incidents };
}

interface IncidentContextRow {
  readonly id: string;
  readonly resident_id: string;
  readonly created_at: Date;
  readonly status: string;
  readonly missing_fields_reminder_sent_at: Date | null;
  readonly missing_mandatory: string[] | null;
}

export async function loadMissingFieldsContext(
  input: LoadMissingFieldsContextInput,
): Promise<MissingFieldsContext | null> {
  const row = await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query<IncidentContextRow>(
        `SELECT i.id,
                i.resident_id,
                i.created_at,
                i.status::text AS status,
                i.missing_fields_reminder_sent_at,
                v.missing_mandatory
           FROM core.incidents i
           JOIN core.incident_versions v
             ON v.incident_id = i.id
            AND v.version     = i.current_version
          WHERE i.id = $1::uuid
          LIMIT 1`,
        [input.incidentId],
      );
      return result.rows[0] ?? null;
    },
  );

  if (row === null) {
    return null;
  }

  return {
    alreadyReminded: row.missing_fields_reminder_sent_at !== null,
    createdAtIso: row.created_at.toISOString(),
    incidentId: row.id,
    missingFields: row.missing_mandatory ?? [],
    residentId: row.resident_id,
    status: row.status,
  };
}

export async function markMissingFieldsReminderSent(
  input: MarkMissingFieldsReminderSentInput,
): Promise<MarkMissingFieldsReminderSentResult> {
  const updated = await withTenantContext(
    { actor: input.actor, homeId: input.homeId, tenantId: input.tenantId },
    async (client) => {
      const result = await client.query(
        `UPDATE core.incidents
            SET missing_fields_reminder_sent_at = NOW()
          WHERE id = $1::uuid
            AND missing_fields_reminder_sent_at IS NULL`,
        [input.incidentId],
      );
      return (result.rowCount ?? 0) > 0;
    },
  );

  return { recorded: updated };
}
