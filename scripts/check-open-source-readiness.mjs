#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = parseMode(process.argv.slice(2));
const errors = [];

const foundationFiles = ['LICENSE', 'NOTICE', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.md'];
const communityFiles = [
  '.github/CODEOWNERS',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/dependabot.yml',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'DCO',
  'GOVERNANCE.md',
  'MAINTAINERS.md',
  'SECURITY.md',
  'SUPPORT.md',
];

for (const path of [...foundationFiles, ...communityFiles]) {
  const absolutePath = resolve(repoRoot, path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    errors.push(`${path}: required file is missing.`);
    continue;
  }
  if (readFileSync(absolutePath, 'utf8').trim().length === 0) {
    errors.push(`${path}: required file is empty.`);
  }
}

const normalizedLicense = readFile('LICENSE').replace(/\n$/, '');
const licenseSha256 = createHash('sha256').update(normalizedLicense).digest('hex');
if (licenseSha256 !== '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd') {
  errors.push('LICENSE: content is not the canonical Apache-2.0 text.');
}

const trackedFiles = gitFiles();
const packageFiles = trackedFiles.filter(
  (path) => path === 'package.json' || path.endsWith('/package.json'),
);
if (packageFiles.length === 0) errors.push('No tracked package.json files were found.');

for (const path of packageFiles) {
  let manifest;
  try {
    manifest = JSON.parse(readFile(path));
  } catch (cause) {
    errors.push(`${path}: cannot parse JSON (${String(cause)}).`);
    continue;
  }
  if (manifest.private !== true) {
    errors.push(`${path}: must retain "private": true until package publication is approved.`);
  }
  if (manifest.license !== 'Apache-2.0') {
    errors.push(`${path}: license must be "Apache-2.0".`);
  }
}

const agentProject = readFile('apps/agent/pyproject.toml');
if (!/^license = "Apache-2\.0"$/m.test(agentProject)) {
  errors.push('apps/agent/pyproject.toml: project license must be Apache-2.0.');
}

if (mode === 'public' || mode === 'release') {
  validatePublicSnapshot(trackedFiles, errors, mode === 'release');
}

if (errors.length > 0) {
  console.error(`open-source ${mode} check FAILED (${errors.length} problem(s)):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `open-source ${mode} check OK (${packageFiles.length} private Apache-2.0 package manifests)`,
);

function parseMode(args) {
  if (args.length === 0) return 'foundation';
  if (
    args.length === 2 &&
    args[0] === '--mode' &&
    ['foundation', 'public', 'release'].includes(args[1])
  ) {
    return args[1];
  }
  console.error('Usage: check-open-source-readiness.mjs [--mode foundation|public|release]');
  process.exit(2);
}

function readFile(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function gitFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean);
}

function validatePublicSnapshot(paths, violations, requireCompleteLicenseReview) {
  const forbiddenExactPaths = new Set([
    '.github/workflows/azure-production.yml',
    '.github/workflows/azure-staging-activation.yml',
    '.github/workflows/azure-staging.yml',
    'docs/azure-deployment-implementation-prompt.md',
    'docs/careos-release-candidate-execution-prompt.md',
    'docs/careos-release-candidate-plan.md',
    'docs/release-readiness.md',
  ]);
  const forbiddenPrefixes = ['.azure/', 'research/sector-analysis/'];

  for (const path of paths) {
    if (
      forbiddenExactPaths.has(path) ||
      forbiddenPrefixes.some((prefix) => path.startsWith(prefix))
    ) {
      violations.push(`${path}: private operational or research content is tracked.`);
    }
  }

  if (
    requireCompleteLicenseReview &&
    !/^\*\*Review status: COMPLETE\.\*\*/m.test(readFile('THIRD_PARTY_NOTICES.md'))
  ) {
    violations.push('THIRD_PARTY_NOTICES.md: license review is not COMPLETE.');
  }
}
