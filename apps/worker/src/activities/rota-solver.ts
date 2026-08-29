import type {
  AnalyzeRotaInput,
  AnalyzeRotaResult,
  RotaRuleSnapshot,
  RotaStaffSnapshot,
} from '@careos/contracts';
import type { RotaGap, RotaProposal, RotaShiftSnapshot } from '@careos/contracts';

// Deterministic heuristic rota solver. Given current shifts + assignments,
// rota rules, and staff metadata, it produces:
//   - gaps: every rule violation, including the (shift, rule) pair, severity,
//     and a human-readable detail.
//   - proposals: one proposal per shift that closes one or more gaps by
//     suggesting staff to add (no removals are proposed; the heuristic never
//     reassigns already-confirmed staff). Proposals are stable: sorted by
//     shiftId then by addUserIds lexicographically.
//
// The solver is pure and free of I/O so the worker activity can call it with
// preloaded snapshots and unit tests can drive it directly.

export function analyzeRota(input: AnalyzeRotaInput): AnalyzeRotaResult {
  const activeRules = input.rules.filter((rule) => rule.active);
  const staffByUserId = new Map(input.staff.map((member) => [member.userId, member]));
  const shifts = [...input.shifts].sort((a, b) => compareShift(a, b));

  const busyShiftsByUserId = new Map<string, RotaShiftSnapshot[]>();
  for (const shift of shifts) {
    for (const userId of shift.assignedUserIds) {
      const list = busyShiftsByUserId.get(userId) ?? [];
      list.push(shift);
      busyShiftsByUserId.set(userId, list);
    }
  }

  const gaps: RotaGap[] = [];
  const proposalsByShift = new Map<string, MutableProposal>();

  for (const shift of shifts) {
    const assignedStaff = shift.assignedUserIds
      .map((id) => staffByUserId.get(id))
      .filter((member): member is RotaStaffSnapshot => member !== undefined);

    const availableStaff = input.staff.filter(
      (member) =>
        !shift.assignedUserIds.includes(member.userId) &&
        !overlapsAnyAssignment(member, shift, busyShiftsByUserId),
    );

    for (const rule of activeRules) {
      const violation = evaluateRule({ rule, shift, assignedStaff, availableStaff });
      if (!violation) continue;
      gaps.push(violation.gap);

      if (violation.candidateUserIds.length > 0) {
        const proposal = ensureProposal(proposalsByShift, shift.id);
        for (const userId of violation.candidateUserIds) {
          if (!proposal.addUserIds.has(userId)) {
            proposal.addUserIds.add(userId);
          }
        }
        proposal.resolvedGapKinds.add(violation.gap.kind);
        proposal.reasons.add(violation.gap.detail);
      }
    }
  }

  const proposals = Array.from(proposalsByShift.values())
    .map(
      (proposal): RotaProposal => ({
        addUserIds: Array.from(proposal.addUserIds).sort(),
        reason: Array.from(proposal.reasons).sort().join(' • '),
        removeUserIds: [],
        resolvedGapKinds: Array.from(proposal.resolvedGapKinds).sort(),
        shiftId: proposal.shiftId,
      }),
    )
    .sort((a, b) =>
      a.shiftId === b.shiftId
        ? a.addUserIds.join(',').localeCompare(b.addUserIds.join(','))
        : a.shiftId.localeCompare(b.shiftId),
    );

  const sortedGaps = [...gaps].sort((a, b) => {
    if (a.shiftId !== b.shiftId) return a.shiftId.localeCompare(b.shiftId);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.ruleName.localeCompare(b.ruleName);
  });

  return { gaps: sortedGaps, proposals };
}

interface MutableProposal {
  readonly shiftId: string;
  readonly addUserIds: Set<string>;
  readonly resolvedGapKinds: Set<RotaGap['kind']>;
  readonly reasons: Set<string>;
}

function ensureProposal(proposals: Map<string, MutableProposal>, shiftId: string): MutableProposal {
  let existing = proposals.get(shiftId);
  if (existing === undefined) {
    existing = {
      addUserIds: new Set<string>(),
      reasons: new Set<string>(),
      resolvedGapKinds: new Set<RotaGap['kind']>(),
      shiftId,
    };
    proposals.set(shiftId, existing);
  }
  return existing;
}

interface RuleViolation {
  readonly gap: RotaGap;
  readonly candidateUserIds: readonly string[];
}

interface EvaluateRuleArgs {
  readonly rule: RotaRuleSnapshot;
  readonly shift: RotaShiftSnapshot;
  readonly assignedStaff: readonly RotaStaffSnapshot[];
  readonly availableStaff: readonly RotaStaffSnapshot[];
}

function evaluateRule(args: EvaluateRuleArgs): RuleViolation | undefined {
  switch (args.rule.kind) {
    case 'min_staffing':
      return evaluateMinStaffing(args);
    case 'gender_mix':
      return evaluateGenderMix(args);
    case 'qualification_flag':
      return evaluateQualificationFlag(args);
    default:
      return undefined;
  }
}

function evaluateMinStaffing({
  rule,
  shift,
  assignedStaff,
  availableStaff,
}: EvaluateRuleArgs): RuleViolation | undefined {
  const params = rule.parameters;
  const requiredRole = typeof params.requiredRole === 'string' ? params.requiredRole : null;
  const minHeadcountRaw = params.minHeadcount;
  const minHeadcount =
    typeof minHeadcountRaw === 'number' && Number.isFinite(minHeadcountRaw)
      ? Math.max(0, Math.floor(minHeadcountRaw))
      : shift.minHeadcount;

  const filtered = requiredRole
    ? assignedStaff.filter((member) => member.roles.includes(requiredRole))
    : assignedStaff;

  if (filtered.length >= minHeadcount) {
    return undefined;
  }

  const missing = minHeadcount - filtered.length;
  const detail = requiredRole
    ? `Shift needs ${minHeadcount} ${requiredRole} on duty; currently ${filtered.length}.`
    : `Shift needs ${minHeadcount} staff on duty; currently ${filtered.length}.`;

  const candidates = availableStaff
    .filter((member) => (requiredRole ? member.roles.includes(requiredRole) : true))
    .slice()
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .slice(0, missing)
    .map((member) => member.userId);

  return {
    candidateUserIds: candidates,
    gap: {
      detail,
      kind: 'min_staffing',
      ruleId: rule.id,
      ruleName: rule.name,
      severity: missing >= 2 ? 'high' : 'medium',
      shiftId: shift.id,
    },
  };
}

function evaluateGenderMix({
  rule,
  shift,
  assignedStaff,
  availableStaff,
}: EvaluateRuleArgs): RuleViolation | undefined {
  const params = rule.parameters;
  const rawRequired = params.requireAtLeastOne;
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  if (required.length === 0) return undefined;

  const presentGenders = new Set(
    assignedStaff
      .map((member) => member.gender)
      .filter((gender): gender is string => typeof gender === 'string' && gender.length > 0),
  );

  const missing = required.filter((gender) => !presentGenders.has(gender));
  if (missing.length === 0) return undefined;

  const candidates: string[] = [];
  for (const gender of missing) {
    const candidate = availableStaff
      .filter((member) => member.gender === gender && !candidates.includes(member.userId))
      .sort((a, b) => a.userId.localeCompare(b.userId))[0];
    if (candidate !== undefined) {
      candidates.push(candidate.userId);
    }
  }

  return {
    candidateUserIds: candidates,
    gap: {
      detail: `Shift requires at least one of: ${required.join(', ')}; missing: ${missing.join(', ')}.`,
      kind: 'gender_mix',
      ruleId: rule.id,
      ruleName: rule.name,
      severity: missing.length >= 2 ? 'high' : 'medium',
      shiftId: shift.id,
    },
  };
}

function evaluateQualificationFlag({
  rule,
  shift,
  assignedStaff,
  availableStaff,
}: EvaluateRuleArgs): RuleViolation | undefined {
  const params = rule.parameters;
  const flagRaw = params.requireFlag ?? params.qualification;
  const flag = typeof flagRaw === 'string' && flagRaw.length > 0 ? flagRaw : null;
  if (flag === null) return undefined;

  const hasFlag = assignedStaff.some((member) => member.qualifications.includes(flag));
  if (hasFlag) return undefined;

  const candidate = availableStaff
    .filter((member) => member.qualifications.includes(flag))
    .sort((a, b) => a.userId.localeCompare(b.userId))[0];

  return {
    candidateUserIds: candidate ? [candidate.userId] : [],
    gap: {
      detail: `Shift requires staff with qualification '${flag}'.`,
      kind: 'qualification_flag',
      ruleId: rule.id,
      ruleName: rule.name,
      severity: 'high',
      shiftId: shift.id,
    },
  };
}

function compareShift(a: RotaShiftSnapshot, b: RotaShiftSnapshot): number {
  if (a.startsAt !== b.startsAt) return a.startsAt.localeCompare(b.startsAt);
  return a.id.localeCompare(b.id);
}

function overlapsAnyAssignment(
  member: RotaStaffSnapshot,
  shift: RotaShiftSnapshot,
  busyShiftsByUserId: ReadonlyMap<string, readonly RotaShiftSnapshot[]>,
): boolean {
  const busy = busyShiftsByUserId.get(member.userId);
  if (!busy) return false;
  return busy.some((other) => other.id !== shift.id && rangesOverlap(shift, other));
}

function rangesOverlap(a: RotaShiftSnapshot, b: RotaShiftSnapshot): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}
