'use client';

import { LogOut } from 'lucide-react';
import { signOut } from 'next-auth/react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

export function SignOutButton({ className }: { readonly className?: string }) {
  const [isSigningOut, setIsSigningOut] = useState(false);

  return (
    <button
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60',
        className,
      )}
      disabled={isSigningOut}
      onClick={() => {
        setIsSigningOut(true);
        void signOut({ callbackUrl: '/' }).catch(() => setIsSigningOut(false));
      }}
      type="button"
    >
      <LogOut className="size-4" aria-hidden="true" />
      {isSigningOut ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
