import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

const workflowsPath = resolve(dirname(fileURLToPath(import.meta.url)), 'index.ts');

describe('Temporal workflow bundle', () => {
  it('bundles without importing Node-only policy or filesystem modules', async () => {
    const bundle = await bundleWorkflowCode({ workflowsPath });
    expect(bundle.code.length).toBeGreaterThan(0);
  }, 60_000);
});
