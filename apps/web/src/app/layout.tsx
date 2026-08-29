import type { Metadata } from 'next';

import './globals.css';

import { BrowserTelemetry } from '@/components/browser-telemetry';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'Kid-OS',
  description: 'Residential child-care operations platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <BrowserTelemetry />
          {children}
        </Providers>
      </body>
    </html>
  );
}
