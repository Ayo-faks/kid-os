import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(workerRoot, 'dist/workflow-bundle.js');
const workflowsPath = resolve(workerRoot, 'dist/workflows/index.js');
const bundle = await bundleWorkflowCode({ workflowsPath });

await writeFile(outputPath, bundle.code, 'utf8');
process.stdout.write(`[worker-build] workflow bundle written to ${outputPath}\n`);
