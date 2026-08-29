import { describe, expect, it } from 'vitest';

import {
  APPROVAL_ROLES,
  AUTOMATION_ROLES,
  MATTERMOST_ADMIN_ROLES,
  REPORT_EXPORT_ROLES,
  REPORT_VIEW_ROLES,
  ROTA_PUBLISH_ROLES,
  SETTINGS_ROLES,
  careosRolesFromAccessToken,
  careosRolesFromClaims,
  hasAnyCareosRole,
} from './roles';

describe('CareOS roles', () => {
  it('reads known realm roles and ignores Keycloak internal roles', () => {
    const accessToken = tokenWithClaims({
      realm_access: {
        roles: ['default-roles-careos', 'support_worker', 'offline_access'],
      },
    });

    expect(careosRolesFromAccessToken(accessToken)).toEqual(['support_worker']);
  });

  it('matches the API precedence for a direct CSV roles claim', () => {
    expect(
      careosRolesFromClaims({
        realm_access: { roles: ['support_worker'] },
        roles: 'manager, safeguarding_lead',
      }),
    ).toEqual(['manager', 'safeguarding_lead']);
  });

  it('fails closed for malformed access tokens', () => {
    expect(careosRolesFromAccessToken('not-a-jwt')).toEqual([]);
  });

  it('does not grant support workers approval access', () => {
    expect(hasAnyCareosRole(['support_worker'], APPROVAL_ROLES)).toBe(false);
    expect(hasAnyCareosRole(['manager'], APPROVAL_ROLES)).toBe(true);
  });

  it('limits rota publication to managers and operations admins', () => {
    expect(hasAnyCareosRole(['support_worker'], ROTA_PUBLISH_ROLES)).toBe(false);
    expect(hasAnyCareosRole(['manager'], ROTA_PUBLISH_ROLES)).toBe(true);
    expect(hasAnyCareosRole(['ops_admin'], ROTA_PUBLISH_ROLES)).toBe(true);
  });

  it('gates automation visibility and Mattermost administration', () => {
    expect(hasAnyCareosRole(['support_worker'], AUTOMATION_ROLES)).toBe(false);
    expect(hasAnyCareosRole(['safeguarding_lead'], AUTOMATION_ROLES)).toBe(true);
    expect(hasAnyCareosRole(['safeguarding_lead'], MATTERMOST_ADMIN_ROLES)).toBe(false);
    expect(hasAnyCareosRole(['ops_admin'], MATTERMOST_ADMIN_ROLES)).toBe(true);
  });

  it('allows broad report viewing but restricts exports and settings', () => {
    expect(hasAnyCareosRole(['support_worker'], REPORT_VIEW_ROLES)).toBe(true);
    expect(hasAnyCareosRole(['support_worker'], REPORT_EXPORT_ROLES)).toBe(false);
    expect(hasAnyCareosRole(['safeguarding_lead'], REPORT_EXPORT_ROLES)).toBe(true);
    expect(hasAnyCareosRole(['manager'], SETTINGS_ROLES)).toBe(false);
    expect(hasAnyCareosRole(['ops_admin'], SETTINGS_ROLES)).toBe(true);
  });
});

function tokenWithClaims(claims: Record<string, unknown>): string {
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${encodedClaims}.signature`;
}
