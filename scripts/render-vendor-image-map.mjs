#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const lockPath = process.argv[2] ?? 'infra/vendor-images.lock.json';
const outputPath = process.argv[3] ?? 'infra/vendor-images.terraform.json';
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const requiredKeys = ['docling', 'gotenberg', 'minio', 'ollama', 'temporal', 'temporal-ui'];
const artifacts = new Map(lock.artifacts.map((artifact) => [artifact.key, artifact]));
const result = {};

for (const key of requiredKeys) {
  const artifact = artifacts.get(key);
  if (artifact === undefined || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '')) {
    throw new Error(`${key}: resolved vendor image is missing from ${lockPath}`);
  }
  result[key] = `${artifact.registry}/${artifact.repository}@${artifact.digest}`;
}

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
