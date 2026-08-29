export const CAREOS_ROLES = [
  'support_worker',
  'key_worker',
  'shift_lead',
  'manager',
  'safeguarding_lead',
  'ops_admin',
] as const;

export type CareosRole = (typeof CAREOS_ROLES)[number];

export const APPROVAL_ROLES = ['manager', 'safeguarding_lead', 'ops_admin'] as const;
export const ROTA_PUBLISH_ROLES = ['manager', 'ops_admin'] as const;
export const AUTOMATION_ROLES = ['manager', 'safeguarding_lead', 'ops_admin'] as const;
export const MATTERMOST_ADMIN_ROLES = ['manager', 'ops_admin'] as const;
export const REPORT_VIEW_ROLES = CAREOS_ROLES;
export const REPORT_EXPORT_ROLES = ['manager', 'safeguarding_lead', 'ops_admin'] as const;
export const SETTINGS_ROLES = ['ops_admin'] as const;

const CAREOS_ROLE_SET = new Set<string>(CAREOS_ROLES);

export function careosRolesFromAccessToken(accessToken: string): readonly CareosRole[] {
  const encodedPayload = accessToken.split('.')[1];
  if (encodedPayload === undefined || encodedPayload.length === 0) return [];

  try {
    const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as unknown;
    return careosRolesFromClaims(claims);
  } catch {
    return [];
  }
}

export function careosRolesFromClaims(claims: unknown): readonly CareosRole[] {
  if (!isRecord(claims)) return [];
  const directRoles = stringArrayClaim(claims.roles);
  const realmAccess = claims.realm_access;
  const claimedRoles =
    directRoles.length > 0
      ? directRoles
      : isRecord(realmAccess)
        ? stringArrayClaim(realmAccess.roles)
        : [];

  return [...new Set(claimedRoles.filter(isCareosRole))];
}

export function hasAnyCareosRole(
  assignedRoles: readonly CareosRole[] | undefined,
  allowedRoles: readonly CareosRole[],
): boolean {
  return allowedRoles.some((role) => assignedRoles?.includes(role) === true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringArrayClaim(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(splitCsvClaim);
  return splitCsvClaim(value);
}

function splitCsvClaim(value: unknown): readonly string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isCareosRole(role: string): role is CareosRole {
  return CAREOS_ROLE_SET.has(role);
}
