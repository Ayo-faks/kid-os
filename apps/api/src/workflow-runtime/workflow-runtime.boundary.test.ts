import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { TemporalModule } from '../temporal/temporal.module.js';
import { TemporalService } from '../temporal/temporal.service.js';

import { WORKFLOW_RUNTIME, type PingWorkflowRuntime } from './workflow-runtime.port.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('workflow runtime boundary', () => {
  it('resolves the engine-neutral token through the Temporal adapter', async () => {
    const startPingWorkflow = vi.fn().mockResolvedValue({
      runId: 'run-boundary',
      taskQueue: 'careos.phase0',
      workflowId: 'phase0-ping-boundary',
    });
    const moduleRef = await Test.createTestingModule({ imports: [TemporalModule] })
      .overrideProvider(TemporalService)
      .useValue({ startPingWorkflow })
      .compile();

    const runtime = moduleRef.get<PingWorkflowRuntime>(WORKFLOW_RUNTIME);
    await expect(runtime.startPingWorkflow('boundary')).resolves.toEqual({
      runId: 'run-boundary',
      taskQueue: 'careos.phase0',
      workflowId: 'phase0-ping-boundary',
    });
    expect(startPingWorkflow).toHaveBeenCalledWith('boundary');

    await moduleRef.close();
  });

  it('keeps TemporalService references inside the runtime adapter boundary', () => {
    const violations = sourceFiles(sourceRoot)
      .filter((path) => isProductionDomainFile(path))
      .filter((path) => readFileSync(path, 'utf8').includes('TemporalService'))
      .map((path) => path.slice(sourceRoot.length + 1));

    expect(violations).toEqual([]);
  });
});

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === '.ts')
    .map((entry) => resolve(entry.parentPath, entry.name));
}

function isProductionDomainFile(path: string): boolean {
  const relativePath = path.slice(sourceRoot.length + 1);
  return (
    !relativePath.includes('__tests__') &&
    !relativePath.endsWith('.test.ts') &&
    !relativePath.startsWith('temporal/') &&
    !relativePath.startsWith('workflow-runtime/')
  );
}
