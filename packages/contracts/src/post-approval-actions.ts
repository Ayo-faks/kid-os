import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const POST_APPROVAL_ACTION_KINDS = ['safeguarding_email', 'export_bundle'] as const;
export type PostApprovalActionKind = (typeof POST_APPROVAL_ACTION_KINDS)[number];

const ActionKindSchema = z.enum(POST_APPROVAL_ACTION_KINDS);
const ActionListSchema = z.array(ActionKindSchema).superRefine((actions, context) => {
  if (new Set(actions).size !== actions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Action list contains duplicates.' });
  }
});
const SubjectPolicySchema = z
  .object({
    conditional: z
      .array(
        z
          .object({
            actions: ActionListSchema,
            when: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
          })
          .strict(),
      )
      .optional(),
    default_actions: ActionListSchema,
  })
  .strict();
const PostApprovalPolicySchema = z
  .object({
    subjects: z.record(z.string(), SubjectPolicySchema),
    version: z.literal(1),
  })
  .strict();

export type PostApprovalPolicy = z.infer<typeof PostApprovalPolicySchema>;

const POLICY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'post-approval-actions.yaml',
);
let cached: PostApprovalPolicy | null = null;

export function loadPostApprovalPolicy(path: string = POLICY_PATH): PostApprovalPolicy {
  if (path === POLICY_PATH && cached !== null) return cached;
  const policy = PostApprovalPolicySchema.parse(parseYaml(readFileSync(path, 'utf8')) as unknown);
  if (path === POLICY_PATH) cached = policy;
  return policy;
}

export function resolvePostApprovalActions(
  subject: string,
  context: Readonly<Record<string, string | number | boolean | undefined>> = {},
  policy: PostApprovalPolicy = loadPostApprovalPolicy(),
): readonly PostApprovalActionKind[] {
  const entry = policy.subjects[subject];
  if (entry === undefined) throw new Error(`Unknown post-approval subject: ${subject}`);
  for (const rule of entry.conditional ?? []) {
    if (Object.entries(rule.when).every(([key, value]) => context[key] === value)) {
      return [...rule.actions];
    }
  }
  return [...entry.default_actions];
}
