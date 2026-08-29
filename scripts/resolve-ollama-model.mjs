#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';

const lockPath = process.argv[2] ?? 'infra/ollama-model.lock.json';
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
if (lock.schemaVersion !== 1 || !nonEmptyString(lock.repository) || !nonEmptyString(lock.tag)) {
  throw new Error(`${lockPath}: unsupported model lock schema`);
}

const registry = lock.registry ?? 'registry.ollama.ai';
const url = `https://${registry}/v2/${lock.repository}/manifests/${lock.tag}`;
const response = await fetch(url, {
  headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' },
});
if (!response.ok) throw new Error(`${url}: registry returned HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const manifest = JSON.parse(bytes.toString('utf8'));
if (manifest.schemaVersion !== 2 || !validDescriptor(manifest.config)) {
  throw new Error(`${url}: invalid model manifest`);
}
if (!Array.isArray(manifest.layers) || !manifest.layers.every(validDescriptor)) {
  throw new Error(`${url}: invalid model layers`);
}

lock.manifestDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
lock.config = manifest.config;
lock.layers = manifest.layers;
lock.resolvedAt = new Date().toISOString();
const prettierConfig = (await resolveConfig(lockPath)) ?? {};
await writeFile(
  lockPath,
  await format(JSON.stringify(lock), { ...prettierConfig, parser: 'json' }),
);

function validDescriptor(value) {
  return (
    typeof value?.mediaType === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value?.digest ?? '') &&
    Number.isInteger(value?.size) &&
    value.size >= 0
  );
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
