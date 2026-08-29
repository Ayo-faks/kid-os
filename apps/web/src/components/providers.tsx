'use client';

import { SessionProvider } from 'next-auth/react';
import { type ReactNode } from 'react';

export function Providers({ children }: { readonly children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
