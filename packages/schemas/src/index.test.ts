import { describe, expect, it } from 'vitest';

import {
  FORM_TEMPLATES,
  findFormTemplate,
  getMissingMandatoryFields,
  loadFormTemplate,
  validateFormData,
  validatePartialFormData,
} from './index.js';

describe('form template catalogue', () => {
  it('exposes the v1 templates', () => {
    expect(FORM_TEMPLATES.map((t) => t.id)).toEqual([
      'incident.behavioural',
      'incident.safeguarding',
      'incident.medication-near-miss',
      'handover.shift-end',
      'note.observation',
      'comms.email-draft',
    ]);
  });

  it('loads incident.behavioural.v1 (snapshot)', () => {
    const t = loadFormTemplate('incident.behavioural', 'v1');
    expect(t.schema.title).toBe('Behavioural Incident');
    expect(t.schema.required).toMatchInlineSnapshot(`
      [
        "residentId",
        "occurredAt",
        "location",
        "summary",
        "behaviourType",
        "triggers",
        "responseTaken",
        "outcomeForResident",
      ]
    `);
    expect(t.uiSchema.sections?.map((s) => s.title)).toEqual([
      'Basics',
      'What happened',
      'Intervention',
      'Outcome',
    ]);
  });

  it('returns undefined for unknown templates', () => {
    expect(findFormTemplate('nope', 'v1')).toBeUndefined();
  });
});

describe('getMissingMandatoryFields', () => {
  it('flags missing top-level x-mandatory fields', () => {
    const { schema } = loadFormTemplate('incident.behavioural', 'v1');
    const missing = getMissingMandatoryFields(schema, {
      residentId: '00000000-0000-0000-0000-000000000001',
      occurredAt: '2026-05-16T10:00:00Z',
      // location, summary, behaviourType, triggers, responseTaken, outcomeForResident missing
    });
    expect(missing).toEqual([
      'location',
      'summary',
      'behaviourType',
      'triggers',
      'responseTaken',
      'outcomeForResident',
    ]);
  });

  it('treats empty strings and empty arrays as missing', () => {
    const { schema } = loadFormTemplate('incident.behavioural', 'v1');
    const missing = getMissingMandatoryFields(schema, {
      residentId: '00000000-0000-0000-0000-000000000001',
      occurredAt: '2026-05-16T10:00:00Z',
      location: '   ',
      summary: 'A full and factual account of what happened on the day.',
      behaviourType: 'verbal_aggression',
      triggers: [],
      responseTaken: 'De-escalated using planned strategies from the PBS plan.',
      outcomeForResident: 'Calmed within 15 minutes; resumed evening routine.',
    });
    expect(missing).toEqual(['location', 'triggers']);
  });

  it('descends into object sub-schemas (medication)', () => {
    const { schema } = loadFormTemplate('incident.medication-near-miss', 'v1');
    const missing = getMissingMandatoryFields(schema, {
      residentId: '00000000-0000-0000-0000-000000000001',
      occurredAt: '2026-05-16T10:00:00Z',
      medication: {},
      nearMissType: 'wrong_dose',
      summary: 'Dispensed double dose; caught at second check.',
      harmCausedToResident: 'none',
      correctiveAction: 'Re-checked MAR; informed pharmacy; updated SOP.',
    });
    expect(missing).toEqual(['medication.name']);
  });
});

describe('validateFormData', () => {
  const validBehaviouralIncident = {
    behaviourType: 'verbal_aggression',
    location: 'lounge',
    occurredAt: '2026-01-01T10:00:00Z',
    outcomeForResident: 'Calmed down and resumed the planned activity.',
    residentId: '11111111-1111-4111-8111-111111111111',
    responseTaken: 'Staff used the agreed de-escalation plan.',
    summary: 'The resident became verbally distressed during a transition.',
    triggers: ['unexpected transition'],
  };

  it('accepts a fully valid form', () => {
    expect(validateFormData('incident.behavioural', 'v1', validBehaviouralIncident)).toEqual({
      errors: [],
      missingMandatory: [],
      valid: true,
    });
  });

  it('enforces formats, enums, lengths, and additionalProperties with JSON pointers', () => {
    const result = validateFormData('incident.behavioural', 'v1', {
      ...validBehaviouralIncident,
      behaviourType: 'invented_value',
      occurredAt: 'not-a-date',
      rogueField: true,
      summary: 'short',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['/behaviourType', '/occurredAt', '/rogueField', '/summary']),
    );
  });

  it('allows omitted mandatory fields in partial drafts but validates provided values', () => {
    const partial = validatePartialFormData('incident.behavioural', 'v1', {
      residentId: '11111111-1111-4111-8111-111111111111',
      summary: 'A valid partial summary that is long enough.',
    });
    expect(partial.valid).toBe(true);
    expect(partial.missingMandatory).toContain('occurredAt');

    const malformed = validatePartialFormData('incident.behavioural', 'v1', {
      residentId: 'not-a-uuid',
      rogueField: true,
    });
    expect(malformed.valid).toBe(false);
    expect(malformed.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['/residentId', '/rogueField']),
    );
  });
});
