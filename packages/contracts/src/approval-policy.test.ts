import { describe, expect, it } from 'vitest';

import {
  APPROVAL_LEVELS,
  getSkillPolicy,
  loadApprovalPolicy,
  resolveApprovalLevel,
  resolveApprovalRequirement,
} from './approval-policy.js';

describe('approval-policy.yaml', () => {
  it('parses with the locked schema and version', () => {
    const policy = loadApprovalPolicy();
    expect(policy.version).toBe(1);
    expect(Object.keys(policy.skills).length).toBeGreaterThan(0);
  });

  it('only uses declared approval levels', () => {
    const policy = loadApprovalPolicy();
    for (const skill of Object.values(policy.skills)) {
      expect(APPROVAL_LEVELS).toContain(skill.level);
      for (const rule of skill.conditional ?? []) {
        expect(APPROVAL_LEVELS).toContain(rule.level);
      }
    }
  });

  it('maps every shipped Hermes skill to the expected default level', () => {
    const cases: ReadonlyArray<readonly [string, 'none' | 'confirm' | 'dual_sign_off']> = [
      ['ping', 'none'],
      ['list_form_templates', 'none'],
      ['narrate_rota', 'none'],
      ['draft_incident_from_text', 'confirm'],
      ['summarize_handover', 'confirm'],
      ['draft_email', 'none'],
    ];
    for (const [skill, expected] of cases) {
      expect(getSkillPolicy(skill).level).toBe(expected);
    }
  });

  it('escalates draft_email to dual_sign_off when sensitivity is sensitive', () => {
    expect(resolveApprovalLevel('draft_email', { sensitivity: 'sensitive' })).toBe('dual_sign_off');
    expect(resolveApprovalLevel('draft_email', { sensitivity: 'routine' })).toBe('none');
    expect(resolveApprovalLevel('draft_email')).toBe('none');
  });

  it('resolves exact role coverage from the shared policy', () => {
    expect(resolveApprovalRequirement('draft_incident_from_text')).toEqual({
      level: 'confirm',
      requiredRoles: ['manager'],
      signaturesRequired: 1,
    });
    expect(resolveApprovalRequirement('draft_incident_from_text', { safeguarding: true })).toEqual({
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
    });
    expect(resolveApprovalRequirement('draft_email', { sensitivity: 'sensitive' })).toEqual({
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      signaturesRequired: 2,
    });
  });

  it('throws on unknown skill', () => {
    expect(() => getSkillPolicy('does_not_exist')).toThrow(/Unknown skill/);
  });
});
