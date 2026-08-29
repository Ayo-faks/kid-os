#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';

const lockPath = process.argv[2] ?? '.github/actions.lock.json';
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
if (lock.schemaVersion !== 1 || !Array.isArray(lock.actions)) {
  throw new Error(`${lockPath}: unsupported action lock schema`);
}

for (const action of lock.actions) {
  const refs = execFileSync(
    'git',
    [
      'ls-remote',
      `https://github.com/${action.repository}.git`,
      `refs/tags/${action.sourceTag}`,
      `refs/tags/${action.sourceTag}^{}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const peeled = refs.find((line) => line.endsWith(`refs/tags/${action.sourceTag}^{}`));
  const direct = refs.find((line) => line.endsWith(`refs/tags/${action.sourceTag}`));
  const selected = peeled ?? direct;
  if (selected === undefined)
    throw new Error(`${action.repository}@${action.sourceTag}: tag missing`);
  const commit = selected.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`${action.repository}@${action.sourceTag}: invalid commit ${commit}`);
  }
  action.commit = commit;
  action.resolvedAt = new Date().toISOString();
}

lock.resolvedAt = new Date().toISOString();
const prettierConfig = (await resolveConfig(lockPath)) ?? {};
await writeFile(
  lockPath,
  await format(JSON.stringify(lock), { ...prettierConfig, parser: 'json' }),
);
