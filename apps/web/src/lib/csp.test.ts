import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from './csp';

describe('buildContentSecurityPolicy', () => {
  it('permits only nonce-bearing inline scripts in production', () => {
    const policy = buildContentSecurityPolicy('request-nonce', false);

    expect(policy).toContain("script-src 'self' 'nonce-request-nonce' 'strict-dynamic'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(policy).toContain("img-src 'self' data: https://authjs.dev");
    expect(policy).toContain('upgrade-insecure-requests');
  });

  it('allows the React development runtime without upgrading local requests', () => {
    const policy = buildContentSecurityPolicy('development-nonce', true);

    expect(policy).toContain("'unsafe-eval'");
    expect(policy).not.toContain('upgrade-insecure-requests');
  });
});
