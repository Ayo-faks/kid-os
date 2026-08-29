import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifests = [
  resolve(repoRoot, 'packages/contracts/package.json'),
  resolve(repoRoot, 'packages/object-storage/package.json'),
  resolve(repoRoot, 'packages/schemas/package.json'),
];
const originals = new Map(manifests.map((path) => [path, readFileSync(path, 'utf8')]));

try {
  run('pnpm', ['--filter', '@careos/contracts', 'build']);
  run('pnpm', ['--filter', '@careos/object-storage', 'build']);
  run('pnpm', ['--filter', '@careos/schemas', 'build']);
  writeCompiledWorkspaceExports();
  run('pnpm', ['--filter', '@careos/api', 'exec', 'tsc', '-p', 'tsconfig.json']);
  run(process.execPath, ['apps/api/dist/openapi.generate.js'], {
    OPENAPI_OUTPUT_PATH: resolve(repoRoot, 'packages/contracts/openapi.yaml'),
  });
} finally {
  for (const [path, content] of originals) {
    writeFileSync(path, content);
  }
}

function run(command, args, extraEnv = {}) {
  execFileSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
}

function writeCompiledWorkspaceExports() {
  updatePackage(resolve(repoRoot, 'packages/contracts/package.json'), {
    '.': {
      default: './dist/index.js',
      import: './dist/index.js',
      types: './dist/index.d.ts',
    },
    './workflow': {
      default: './dist/workflow.js',
      import: './dist/workflow.js',
      types: './dist/workflow.d.ts',
    },
  });

  updatePackage(resolve(repoRoot, 'packages/object-storage/package.json'), {
    '.': {
      default: './dist/index.js',
      import: './dist/index.js',
      types: './dist/index.d.ts',
    },
  });

  updatePackage(resolve(repoRoot, 'packages/schemas/package.json'), {
    '.': {
      default: './dist/index.js',
      import: './dist/index.js',
      types: './dist/index.d.ts',
    },
    './runtime': {
      default: './dist/runtime.js',
      import: './dist/runtime.js',
      types: './dist/runtime.d.ts',
    },
    './schemas/*': './schemas/*',
  });
}

function updatePackage(packagePath, exportsMap) {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  packageJson.main = './dist/index.js';
  packageJson.types = './dist/index.d.ts';
  packageJson.exports = exportsMap;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}
