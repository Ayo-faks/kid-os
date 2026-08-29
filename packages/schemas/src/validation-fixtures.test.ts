import { describe, expect, it } from 'vitest';

import { validateFormData } from './index.js';

const residentId = '11111111-1111-4111-8111-111111111111';
const shiftId = '22222222-2222-4222-8222-222222222222';

const validFixtures = [
  {
    data: {
      behaviourType: 'verbal_aggression',
      injuries: [{ description: 'Small graze to the hand.', firstAidGiven: true, who: 'resident' }],
      location: 'lounge',
      occurredAt: '2026-07-10T10:00:00Z',
      outcomeForResident: 'Calmed and returned to the planned activity.',
      physicalInterventionDetail: 'Two staff used the approved guiding technique.',
      physicalInterventionUsed: true,
      residentId,
      responseTaken: 'Staff followed the agreed de-escalation plan.',
      summary: 'The resident became verbally distressed during an unexpected transition.',
      triggers: ['unexpected transition'],
    },
    templateId: 'incident.behavioural',
  },
  {
    data: {
      category: 'physical_abuse',
      discoveredAt: '2026-07-10T10:10:00Z',
      externalAgenciesNotified: [
        { agency: 'local_authority', notifiedAt: '2026-07-10T10:30:00Z', reference: 'LA-1' },
      ],
      immediateActionsTaken: 'The child was moved to a safe space and the DSL was informed.',
      isChildAtImmediateRisk: true,
      occurredAt: '2026-07-10T09:30:00Z',
      perpetratorDetail: 'Known adult connected to the placement.',
      perpetratorKnown: true,
      reportedToDsl: true,
      reportedToDslAt: '2026-07-10T10:15:00Z',
      residentId,
      summary: 'The child made a disclosure that requires immediate safeguarding review.',
    },
    templateId: 'incident.safeguarding',
  },
  {
    data: {
      correctiveAction: 'The second checker stopped administration and the MAR was reviewed.',
      harmCausedToResident: 'none',
      medication: {
        doseActual: '10mg',
        doseExpected: '5mg',
        name: 'Example medicine',
        route: 'oral',
      },
      nearMissType: 'wrong_dose',
      occurredAt: '2026-07-10T11:00:00Z',
      residentId,
      summary: 'A double dose was prepared but caught during the second check.',
    },
    templateId: 'incident.medication-near-miss',
  },
  {
    data: {
      endedAt: '2026-07-10T15:00:00Z',
      narrative: 'The shift was calm; one resident needs a follow-up conversation tomorrow.',
      openTasks: ['33333333-3333-4333-8333-333333333333'],
      residentsRequiringFollowUp: [
        { note: 'Check in after breakfast.', priority: 'medium', residentId },
      ],
      shiftId,
    },
    templateId: 'handover.shift-end',
  },
  {
    data: {
      body: 'The resident took part in the activity and engaged positively with peers.',
      mood: 'positive',
      observedAt: '2026-07-10T12:00:00Z',
      residentId,
      tags: ['activity', 'peer-engagement'],
    },
    templateId: 'note.observation',
  },
  {
    data: {
      body: 'This is a routine update about the planned meeting later this week.',
      recipient: { email: 'manager@example.test', name: 'Home Manager', role: 'manager' },
      sensitivity: 'routine',
      sensitivity_reasons: ['routine operational update'],
      subject: 'Planned meeting update',
    },
    templateId: 'comms.email-draft',
  },
] as const;

interface InvalidFixture {
  readonly data: Readonly<Record<string, unknown>>;
  readonly expectedMissing?: string;
  readonly expectedPath: string;
  readonly templateId: string;
}

const invalidFixtures: readonly InvalidFixture[] = [
  {
    data: {
      ...validFixtures[0].data,
      physicalInterventionDetail: undefined,
      physicalInterventionUsed: true,
    },
    expectedMissing: 'physicalInterventionDetail',
    expectedPath: '/physicalInterventionDetail',
    templateId: 'incident.behavioural',
  },
  {
    data: {
      ...validFixtures[1].data,
      reportedToDslAt: undefined,
    },
    expectedMissing: 'reportedToDslAt',
    expectedPath: '/reportedToDslAt',
    templateId: 'incident.safeguarding',
  },
  {
    data: {
      ...validFixtures[2].data,
      medication: { route: 'intravenous' },
    },
    expectedMissing: 'medication.name',
    expectedPath: '/medication/name',
    templateId: 'incident.medication-near-miss',
  },
  {
    data: {
      ...validFixtures[3].data,
      residentsRequiringFollowUp: [{ note: '', priority: 'urgent', residentId: 'not-a-uuid' }],
    },
    expectedPath: '/residentsRequiringFollowUp/0/residentId',
    templateId: 'handover.shift-end',
  },
  {
    data: {
      ...validFixtures[4].data,
      mood: 'ecstatic',
      tags: ['x'.repeat(41)],
    },
    expectedPath: '/mood',
    templateId: 'note.observation',
  },
  {
    data: {
      ...validFixtures[5].data,
      body: 'too short',
      recipient: { email: 'not-an-email', unexpected: true },
    },
    expectedPath: '/recipient/email',
    templateId: 'comms.email-draft',
  },
];

describe('all shipped form templates', () => {
  it.each(validFixtures)('$templateId accepts its valid fixture', ({ data, templateId }) => {
    expect(validateFormData(templateId, 'v1', data)).toEqual({
      errors: [],
      missingMandatory: [],
      valid: true,
    });
  });

  it.each(invalidFixtures)(
    '$templateId rejects its targeted invalid fixture',
    ({ data, expectedMissing, expectedPath, templateId }) => {
      const result = validateFormData(templateId, 'v1', data);
      expect(result.valid).toBe(false);
      expect(result.errors.map((error) => error.path)).toContain(expectedPath);
      if (expectedMissing !== undefined) {
        expect(result.missingMandatory).toContain(expectedMissing);
      }
    },
  );

  it('rejects nested and top-level extra properties where the schema forbids them', () => {
    const email = validFixtures.find((fixture) => fixture.templateId === 'comms.email-draft');
    expect(email).toBeDefined();
    const result = validateFormData('comms.email-draft', 'v1', {
      ...email?.data,
      injected: 'top-level',
      recipient: { email: 'manager@example.test', injected: 'nested' },
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.path)).toEqual(
      expect.arrayContaining(['/injected', '/recipient/injected']),
    );
  });
});
