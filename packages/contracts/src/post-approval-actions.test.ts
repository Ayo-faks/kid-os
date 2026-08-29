import { describe, expect, it } from 'vitest';

import { loadPostApprovalPolicy, resolvePostApprovalActions } from './post-approval-actions.js';

describe('post-approval-actions.yaml', () => {
  it('parses the locked version', () => {
    expect(loadPostApprovalPolicy().version).toBe(1);
  });

  it('creates governed email and export actions for safeguarding incidents only', () => {
    expect(resolvePostApprovalActions('incident', { safeguarding: true })).toEqual([
      'safeguarding_email',
      'export_bundle',
    ]);
    expect(resolvePostApprovalActions('incident', { safeguarding: false })).toEqual([]);
    expect(resolvePostApprovalActions('incident')).toEqual([]);
  });

  it('rejects unknown subjects', () => {
    expect(() => resolvePostApprovalActions('unknown')).toThrow(/Unknown post-approval subject/);
  });
});
