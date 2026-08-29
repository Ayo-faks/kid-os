import 'next-auth';
import 'next-auth/jwt';

import type { CareosRole } from '../lib/roles';

declare module 'next-auth' {
  interface Session {
    accessToken?: string;
    authError?: string;
    roles?: readonly CareosRole[];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string;
    accessTokenExpiresAt?: number;
    error?: string;
    refreshToken?: string;
    roles?: readonly CareosRole[];
  }
}
