import { getServerSession, type NextAuthOptions, type Session } from 'next-auth';
import type { JWT } from 'next-auth/jwt';
import KeycloakProvider from 'next-auth/providers/keycloak';

import { careosRolesFromAccessToken, careosRolesFromClaims } from './roles';

const internalIssuer = (): string =>
  process.env.KEYCLOAK_INTERNAL_ISSUER ??
  process.env.KEYCLOAK_ISSUER ??
  'https://localhost/keycloak/realms/careos';

interface RefreshFlight {
  readonly expiresAt: number;
  readonly promise: Promise<JWT>;
}

const refreshFlights = new Map<string, RefreshFlight>();

/**
 * Keycloak access tokens expire after ~5 minutes; without rotation every
 * API call starts failing with expired-token errors shortly after sign-in.
 */
export async function refreshAccessToken(token: JWT): Promise<JWT> {
  if (typeof token.refreshToken !== 'string') {
    return invalidToken(token, 'RefreshTokenMissing');
  }

  const cached = refreshFlights.get(token.refreshToken);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = requestAccessTokenRefresh(token);
  refreshFlights.set(token.refreshToken, {
    expiresAt: Date.now() + 30_000,
    promise,
  });
  return promise;
}

async function requestAccessTokenRefresh(token: JWT): Promise<JWT> {
  const refreshToken = token.refreshToken;
  if (typeof refreshToken !== 'string') return invalidToken(token, 'RefreshTokenMissing');
  try {
    const response = await fetch(`${internalIssuer()}/protocol/openid-connect/token`, {
      body: new URLSearchParams({
        client_id: process.env.KEYCLOAK_WEB_CLIENT_ID ?? 'web',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    });
    if (!response.ok) {
      return invalidToken(token, 'RefreshAccessTokenError');
    }
    const refreshed = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
    return {
      ...token,
      accessToken: refreshed.access_token,
      accessTokenExpiresAt: Date.now() + refreshed.expires_in * 1000,
      error: undefined,
      refreshToken: refreshed.refresh_token ?? refreshToken,
      roles: careosRolesFromAccessToken(refreshed.access_token),
    };
  } catch {
    return invalidToken(token, 'RefreshAccessTokenError');
  }
}

function invalidToken(token: JWT, error: string): JWT {
  return {
    ...token,
    accessToken: undefined,
    accessTokenExpiresAt: 0,
    error,
    roles: [],
  };
}

export const authOptions: NextAuthOptions = {
  providers: [
    (() => {
      const publicIssuer =
        process.env.KEYCLOAK_ISSUER ?? 'https://localhost/keycloak/realms/careos';
      const internalIssuer = process.env.KEYCLOAK_INTERNAL_ISSUER ?? publicIssuer;
      return KeycloakProvider({
        clientId: process.env.KEYCLOAK_WEB_CLIENT_ID ?? 'web',
        clientSecret: process.env.KEYCLOAK_WEB_CLIENT_SECRET ?? '',
        checks: ['pkce', 'state'],
        client: {
          token_endpoint_auth_method: 'none',
        },
        // openid-client defaults to 3.5s, which flakes against a busy local
        // Keycloak and fails every sign-in with SIGNIN_OAUTH_ERROR.
        httpOptions: { timeout: 15_000 },
        issuer: publicIssuer,
        wellKnown: `${internalIssuer}/.well-known/openid-configuration`,
        authorization: `${publicIssuer}/protocol/openid-connect/auth`,
        token: `${internalIssuer}/protocol/openid-connect/token`,
        userinfo: `${internalIssuer}/protocol/openid-connect/userinfo`,
        jwks_endpoint: `${internalIssuer}/protocol/openid-connect/certs`,
      });
    })(),
  ],
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    async jwt({ token, account }) {
      if (account !== null && account !== undefined) {
        const accessToken = account.access_token;
        return {
          ...token,
          accessToken,
          accessTokenExpiresAt:
            typeof account.expires_at === 'number' ? account.expires_at * 1000 : 0,
          error: undefined,
          refreshToken: account.refresh_token,
          roles: typeof accessToken === 'string' ? careosRolesFromAccessToken(accessToken) : [],
        };
      }
      const expiresAt =
        typeof token.accessTokenExpiresAt === 'number' ? token.accessTokenExpiresAt : 0;
      // Refresh 30s before expiry so in-flight requests never carry a stale token.
      if (Date.now() < expiresAt - 30_000) {
        return {
          ...token,
          roles:
            typeof token.accessToken === 'string'
              ? careosRolesFromAccessToken(token.accessToken)
              : [],
        };
      }
      return refreshAccessToken(token);
    },
    session({ session, token }) {
      if (typeof token.error === 'string') {
        session.authError = token.error;
      } else if (typeof token.accessToken === 'string') {
        session.accessToken = token.accessToken;
      }
      session.roles = careosRolesFromClaims({ roles: token.roles });
      return session;
    },
  },
};

export async function getCareosServerSession(): Promise<Session | null> {
  if (process.env.CAREOS_E2E_AUTH_BYPASS === 'true') {
    return {
      accessToken: process.env.CAREOS_DEV_API_TOKEN ?? 'careos-e2e-token',
      expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      roles: careosRolesFromClaims({
        roles: process.env.CAREOS_E2E_ROLES ?? 'manager,safeguarding_lead,ops_admin',
      }),
      user: {
        email: 'e2e.support@careos.local',
        name: 'E2E Support Worker',
      },
    };
  }

  const session = await getServerSession(authOptions);
  return session?.authError === undefined ? session : null;
}

export function apiAuthorizationHeaders(session: Session | null): Record<string, string> {
  if (typeof session?.accessToken === 'string') {
    return { authorization: `Bearer ${session.accessToken}` };
  }
  if (process.env.CAREOS_DEV_API_TOKEN !== undefined) {
    return { authorization: `Bearer ${process.env.CAREOS_DEV_API_TOKEN}` };
  }
  return {};
}
