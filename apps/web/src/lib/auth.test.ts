import type { JWT } from 'next-auth/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshAccessToken } from './auth';

const originalFetch = globalThis.fetch;

describe('NextAuth access-token refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('shares one Keycloak rotation across concurrent server requests', async () => {
    const refreshedAccessToken = accessTokenWithRoles(['manager']);
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json({
          access_token: refreshedAccessToken,
          expires_in: 300,
          refresh_token: 'new-refresh-token',
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const token: JWT = {
      accessToken: 'expired-access-token',
      accessTokenExpiresAt: 0,
      refreshToken: 'concurrent-refresh-token',
    };

    const [first, second] = await Promise.all([
      refreshAccessToken(token),
      refreshAccessToken(token),
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(first).toMatchObject({
      accessToken: refreshedAccessToken,
      error: undefined,
      refreshToken: 'new-refresh-token',
      roles: ['manager'],
    });
    expect(second).toEqual(first);
  });

  it('fails closed and removes a stale bearer token when rotation is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 400 }))),
    );
    const token: JWT = {
      accessToken: 'expired-access-token',
      accessTokenExpiresAt: 0,
      refreshToken: 'rejected-refresh-token',
    };

    await expect(refreshAccessToken(token)).resolves.toMatchObject({
      accessToken: undefined,
      accessTokenExpiresAt: 0,
      error: 'RefreshAccessTokenError',
    });
  });

  it('fails closed when no refresh token exists', async () => {
    await expect(
      refreshAccessToken({ accessToken: 'expired-access-token', accessTokenExpiresAt: 0 }),
    ).resolves.toMatchObject({
      accessToken: undefined,
      error: 'RefreshTokenMissing',
    });
  });
});

function accessTokenWithRoles(roles: readonly string[]): string {
  const payload = Buffer.from(JSON.stringify({ realm_access: { roles } })).toString('base64url');
  return `header.${payload}.signature`;
}
