// Phase 3 §4 — shared approval policy reader. Loads
// `packages/contracts/approval-policy.yaml` and validates it with Zod. Both
// this reader and the Python equivalent in `apps/agent` MUST agree on the
// approval level for every skill; the cross-language assertion test lives
// in `approval-policy.test.ts` and `apps/agent/tests/test_approval_policy.py`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const APPROVAL_LEVELS = ['none', 'confirm', 'dual_sign_off'] as const;
export type ApprovalLevel = (typeof APPROVAL_LEVELS)[number];
export const APPROVAL_ROLES = ['manager', 'safeguarding_lead'] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

const ApprovalLevelSchema = z.enum(APPROVAL_LEVELS);
const ApprovalRoleSchema = z.enum(APPROVAL_ROLES);

const ConditionalRuleSchema = z
  .object({
    when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    level: ApprovalLevelSchema,
    required_roles: z.array(ApprovalRoleSchema).max(2),
  })
  .strict();

const SkillPolicySchema = z
  .object({
    level: ApprovalLevelSchema,
    required_roles: z.array(ApprovalRoleSchema).max(2),
    description: z.string().min(1),
    conditional: z.array(ConditionalRuleSchema).optional(),
  })
  .strict();

const ApprovalPolicySchema = z
  .object({
    version: z.literal(1),
    skills: z.record(z.string(), SkillPolicySchema),
  })
  .strict();

export type SkillPolicy = z.infer<typeof SkillPolicySchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export interface ApprovalRequirement {
  readonly level: ApprovalLevel;
  readonly requiredRoles: readonly ApprovalRole[];
  readonly signaturesRequired: 0 | 1 | 2;
}

const POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'approval-policy.yaml');

let cached: ApprovalPolicy | null = null;

export function loadApprovalPolicy(path: string = POLICY_PATH): ApprovalPolicy {
  if (path === POLICY_PATH && cached !== null) {
    return cached;
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  const policy = ApprovalPolicySchema.parse(parsed);
  if (path === POLICY_PATH) {
    cached = policy;
  }
  return policy;
}

export function getSkillPolicy(skill: string, policy?: ApprovalPolicy): SkillPolicy {
  const resolved = policy ?? loadApprovalPolicy();
  const entry = resolved.skills[skill];
  if (entry === undefined) {
    throw new Error(`Unknown skill in approval policy: ${skill}`);
  }
  return entry;
}

/**
 * Resolve the effective approval level for a skill invocation, applying any
 * conditional overrides matching the provided context. Context keys are
 * compared against `conditional[].when` with strict equality.
 */
export function resolveApprovalLevel(
  skill: string,
  context: Readonly<Record<string, string | number | boolean | undefined>> = {},
  policy?: ApprovalPolicy,
): ApprovalLevel {
  const entry = getSkillPolicy(skill, policy);
  for (const rule of entry.conditional ?? []) {
    const matches = Object.entries(rule.when).every(([key, value]) => context[key] === value);
    if (matches) {
      return rule.level;
    }
  }
  return entry.level;
}

export function resolveApprovalRequirement(
  skill: string,
  context: Readonly<Record<string, string | number | boolean | undefined>> = {},
  policy?: ApprovalPolicy,
): ApprovalRequirement {
  const entry = getSkillPolicy(skill, policy);
  for (const rule of entry.conditional ?? []) {
    const matches = Object.entries(rule.when).every(([key, value]) => context[key] === value);
    if (matches) {
      return requirement(rule.level, rule.required_roles);
    }
  }
  return requirement(entry.level, entry.required_roles);
}

function requirement(
  level: ApprovalLevel,
  requiredRoles: readonly ApprovalRole[],
): ApprovalRequirement {
  const signaturesRequired = signaturesRequiredFor(level);
  if (requiredRoles.length !== signaturesRequired) {
    throw new Error(
      `Approval level ${level} requires ${signaturesRequired} role(s), got ${requiredRoles.length}.`,
    );
  }
  if (new Set(requiredRoles).size !== requiredRoles.length) {
    throw new Error(`Approval requirement contains duplicate roles: ${requiredRoles.join(', ')}.`);
  }
  return { level, requiredRoles: [...requiredRoles], signaturesRequired };
}

/**
 * Maps an `ApprovalLevel` to the number of distinct approver signatures
 * required to flip an approval to `approved`. `none` returns 0 because no
 * approval is recorded at all; callers must branch on that themselves.
 */
export function signaturesRequiredFor(level: ApprovalLevel): 0 | 1 | 2 {
  switch (level) {
    case 'none':
      return 0;
    case 'confirm':
      return 1;
    case 'dual_sign_off':
      return 2;
  }
}
