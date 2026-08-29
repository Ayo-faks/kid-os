#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'careos-supply-chain-'));
const checks = [
  {
    lock: 'infra/vendor-images.lock.json',
    resolver: 'scripts/resolve-vendor-images.mjs',
  },
  {
    lock: '.github/actions.lock.json',
    resolver: 'scripts/resolve-github-actions.mjs',
  },
  {
    lock: 'infra/ollama-model.lock.json',
    resolver: 'scripts/resolve-ollama-model.mjs',
  },
];

try {
  for (const check of checks) {
    const before = JSON.parse(await readFile(check.lock, 'utf8'));
    const temporaryLock = join(temporary, check.lock.replaceAll('/', '__'));
    await cp(check.lock, temporaryLock);
    execFileSync(process.execPath, [check.resolver, temporaryLock], {
      cwd: root,
      stdio: 'inherit',
    });
    const after = JSON.parse(await readFile(temporaryLock, 'utf8'));
    assert.deepEqual(normalize(after), normalize(before), `${check.lock}: upstream drift detected`);
  }
} finally {
  await rm(temporary, { force: true, recursive: true });
}

console.log('Live supply-chain references match committed locks.');

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['checkedAt', 'resolvedAt'].includes(key))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}
