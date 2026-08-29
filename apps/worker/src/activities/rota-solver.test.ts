import type {
  AnalyzeRotaInput,
  RotaRuleSnapshot,
  RotaStaffSnapshot,
  RotaShiftSnapshot,
} from '@careos/contracts';
import { describe, expect, it } from 'vitest';

import { analyzeRota } from './rota-solver.js';

const SHIFT_A: RotaShiftSnapshot = {
  id: 'shift-a',
  startsAt: '2025-01-06T07:00:00.000Z',
  endsAt: '2025-01-06T15:00:00.000Z',
  requiredRole: 'support_worker',
  minHeadcount: 2,
  assignedUserIds: ['user-1'],
};

const STAFF: RotaStaffSnapshot[] = [
  {
    userId: 'user-1',
    displayName: 'Alice',
    gender: 'female',
    qualifications: ['first_aid'],
    roles: ['support_worker'],
  },
  {
    userId: 'user-2',
    displayName: 'Bob',
    gender: 'male',
    qualifications: ['medication'],
    roles: ['support_worker'],
  },
  {
    userId: 'user-3',
    displayName: 'Carol',
    gender: 'female',
    qualifications: ['medication', 'first_aid'],
    roles: ['support_worker', 'senior'],
  },
];

function input(rules: RotaRuleSnapshot[]): AnalyzeRotaInput {
  return {
    periodStart: '2025-01-06T00:00:00.000Z',
    periodEnd: '2025-01-13T00:00:00.000Z',
    shifts: [SHIFT_A],
    rules,
    staff: STAFF,
  };
}

describe('analyzeRota', () => {
  it('is deterministic across repeated invocations', () => {
    const rules: RotaRuleSnapshot[] = [
      {
        id: 'rule-min',
        name: 'Minimum support workers',
        kind: 'min_staffing',
        parameters: { requiredRole: 'support_worker', minHeadcount: 2 },
        active: true,
      },
    ];
    const first = analyzeRota(input(rules));
    const second = analyzeRota(input(rules));
    expect(second).toEqual(first);
  });

  it('flags min_staffing gaps and proposes the lowest-id available staff', () => {
    const result = analyzeRota(
      input([
        {
          id: 'rule-min',
          name: 'Min',
          kind: 'min_staffing',
          parameters: { requiredRole: 'support_worker', minHeadcount: 2 },
          active: true,
        },
      ]),
    );
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.kind).toBe('min_staffing');
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.addUserIds).toEqual(['user-2']);
    expect(result.proposals[0]?.resolvedGapKinds).toContain('min_staffing');
  });

  it('flags gender_mix gaps with the required gender missing', () => {
    const result = analyzeRota(
      input([
        {
          id: 'rule-g',
          name: 'Gender mix',
          kind: 'gender_mix',
          parameters: { requireAtLeastOne: ['female', 'male'] },
          active: true,
        },
      ]),
    );
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.kind).toBe('gender_mix');
    expect(result.proposals[0]?.addUserIds).toEqual(['user-2']);
  });

  it('flags qualification_flag gaps and proposes a qualified candidate', () => {
    const result = analyzeRota(
      input([
        {
          id: 'rule-q',
          name: 'Medication trained',
          kind: 'qualification_flag',
          parameters: { requireFlag: 'medication' },
          active: true,
        },
      ]),
    );
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]?.kind).toBe('qualification_flag');
    expect(result.proposals[0]?.addUserIds).toEqual(['user-2']);
  });

  it('returns no gaps when all rules are satisfied', () => {
    const result = analyzeRota(
      input([
        {
          id: 'rule-min',
          name: 'Min',
          kind: 'min_staffing',
          parameters: { requiredRole: 'support_worker', minHeadcount: 1 },
          active: true,
        },
      ]),
    );
    expect(result.gaps).toHaveLength(0);
    expect(result.proposals).toHaveLength(0);
  });
});
