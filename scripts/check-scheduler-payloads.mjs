#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const durableRoot = resolve(repoRoot, 'apps/worker/src/durable');
const apiBoundaryRoot = resolve(repoRoot, 'apps/api/src/workflow-runtime');
const policyPath = resolve(durableRoot, 'payload-policy.ts');
const errors = [];
const checks = [];

const forbiddenKeys = readForbiddenKeys(policyPath);
if (forbiddenKeys.size === 0) {
  errors.push('Could not read the canonical forbidden Durable payload keys.');
}

const contractFiles = walk(durableRoot).filter((path) => path.endsWith('.contracts.ts'));
const orchestratorFiles = walk(resolve(durableRoot, 'orchestrators')).filter(
  isProductionTypeScript,
);
const boundaryFiles = [
  ...orchestratorFiles,
  resolve(durableRoot, 'orchestration-starter.ts'),
  resolve(durableRoot, 'worker.ts'),
  ...walk(apiBoundaryRoot).filter((path) =>
    /^durable-.*\.client\.ts$/.test(path.split('/').at(-1) ?? ''),
  ),
];

for (const path of contractFiles) {
  scanForbiddenPropertyNames(path, forbiddenKeys, errors);
}
checks.push({ check: 'contract-property-keys', files: contractFiles.length });

for (const path of boundaryFiles) {
  scanForbiddenPropertyNames(path, forbiddenKeys, errors);
}
checks.push({ check: 'boundary-property-keys', files: boundaryFiles.length });

for (const path of orchestratorFiles) {
  const source = readFileSync(path, 'utf8');
  if (!/assertDurablePayload\s*\(\s*input\b/.test(source)) {
    errors.push(
      `${repoPath(path)}: production orchestrator input lacks assertDurablePayload(input, ...).`,
    );
  }
  const eventWaitCount = countMatches(source, /waitForExternalEvent\s*\(/g);
  const eventGuardCount = countMatches(source, /assertDurablePayload\s*\(\s*event(?:Value)?\b/g);
  if (eventWaitCount > eventGuardCount) {
    errors.push(
      `${repoPath(path)}: ${eventWaitCount} external-event wait(s) but only ${eventGuardCount} event payload guard(s).`,
    );
  }
}
checks.push({ check: 'orchestrator-runtime-guards', files: orchestratorFiles.length });

const policyTestPath = resolve(durableRoot, 'payload-policy.test.ts');
if (!existsSync(policyTestPath)) {
  errors.push(`${repoPath(policyTestPath)}: runtime payload policy tests are missing.`);
} else {
  const testSource = readFileSync(policyTestPath, 'utf8');
  for (const requiredCase of ['form_data', 'freeText', 'message', 'reason', 'summary', 'title']) {
    if (!testSource.includes(`'${requiredCase}'`)) {
      errors.push(`${repoPath(policyTestPath)}: missing rejection case for ${requiredCase}.`);
    }
  }
}
checks.push({ check: 'runtime-policy-tests', files: 1 });

const { gitSha, sourceTree } = readSourceProvenance();
const releaseEvidenceRoot = process.env.CAREOS_EVIDENCE_ROOT?.trim();
const durableEvidenceDirectory = process.env.DURABLE_EVIDENCE_DIR?.trim();
const evidenceDirectory = durableEvidenceDirectory
  ? resolve(repoRoot, durableEvidenceDirectory)
  : resolve(
      releaseEvidenceRoot || resolve(repoRoot, '.tmp/release-evidence'),
      'durable',
      sourceTree === 'dirty' ? `${gitSha}-dirty` : gitSha,
    );
const evidencePath = resolve(evidenceDirectory, 'payload-scan.json');
const evidence = {
  checkId: 'DTS-011',
  checks,
  forbiddenKeys: [...forbiddenKeys].sort(),
  generatedAt: new Date().toISOString(),
  gitSha,
  passed: errors.length === 0,
  sourceTree,
  violations: errors,
};
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

if (errors.length > 0) {
  console.error(`scheduler payload check FAILED (${errors.length} violation(s)):`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error(`Evidence: ${repoPath(evidencePath)}`);
  process.exit(1);
}

console.log(
  `scheduler payload check OK (${contractFiles.length} contract files, ` +
    `${boundaryFiles.length} boundary files, ${orchestratorFiles.length} orchestrators; ` +
    `source tree: ${sourceTree === 'dirty' ? 'dirty, non-release evidence' : sourceTree})`,
);
console.log(`Evidence: ${repoPath(evidencePath)}`);

function readForbiddenKeys(path) {
  const sourceFile = parse(path);
  const keys = new Set();
  sourceFile.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== 'FORBIDDEN_PAYLOAD_KEYS'
      ) {
        continue;
      }
      const initializer = declaration.initializer;
      if (
        initializer === undefined ||
        !ts.isNewExpression(initializer) ||
        initializer.arguments === undefined
      ) {
        continue;
      }
      const array = initializer.arguments[0];
      if (!array || !ts.isArrayLiteralExpression(array)) continue;
      for (const element of array.elements) {
        if (ts.isStringLiteral(element)) keys.add(element.text);
      }
    }
  });
  return keys;
}

function scanForbiddenPropertyNames(path, forbidden, violations) {
  const sourceFile = parse(path);
  visit(sourceFile);

  function visit(node) {
    if (
      ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node) ||
      ts.isBindingElement(node)
    ) {
      const name = propertyName(node.name);
      if (name !== undefined && forbidden.has(normalizeKey(name))) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(
          `${repoPath(path)}:${position.line + 1}: forbidden scheduler payload key "${name}".`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
}

function propertyName(name) {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function normalizeKey(value) {
  return value.toLowerCase().replaceAll(/[_-]/g, '');
}

function parse(path) {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function walk(root) {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return walk(path);
    return statSync(path).isFile() ? [path] : [];
  });
}

function isProductionTypeScript(path) {
  return path.endsWith('.ts') && !path.endsWith('.test.ts');
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readSourceProvenance() {
  const expectedSha = process.env.CAREOS_GIT_SHA?.trim();
  let gitSha;
  try {
    gitSha = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch (cause) {
    if (process.env.CAREOS_IMMUTABLE_IMAGE !== 'true') throw cause;
    if (!/^[0-9a-f]{40}$/.test(expectedSha ?? '')) {
      throw new Error('Immutable-image payload evidence requires an exact CAREOS_GIT_SHA.', {
        cause,
      });
    }
    return { gitSha: expectedSha, sourceTree: 'immutable-image' };
  }

  if (!/^[0-9a-f]{40}$/.test(gitSha)) {
    throw new Error('Scheduler payload evidence requires a full source commit SHA.');
  }
  if (expectedSha !== undefined && expectedSha !== '' && expectedSha !== gitSha) {
    throw new Error('CAREOS_GIT_SHA differs from the checked-out source commit.');
  }
  const dirty = git(['status', '--porcelain=v2', '--untracked-files=all']).length > 0;
  return { gitSha, sourceTree: dirty ? 'dirty' : 'clean' };
}

function repoPath(path) {
  return relative(repoRoot, path).replaceAll('\\', '/');
}
