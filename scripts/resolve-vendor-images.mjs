#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';

const lockPath = process.argv[2] ?? 'infra/vendor-images.lock.json';
const requestedKeys = new Set(process.argv.slice(3));
const lock = JSON.parse(await readFile(lockPath, 'utf8'));

if (lock.schemaVersion !== 1 || !Array.isArray(lock.artifacts)) {
  throw new Error(`${lockPath}: unsupported vendor lock schema`);
}

for (const artifact of lock.artifacts) {
  if (requestedKeys.size > 0 && !requestedKeys.has(artifact.key)) continue;
  const resolved = await resolveReference(artifact.source);
  const missingPlatforms = (artifact.requiredPlatforms ?? []).filter(
    (platform) => !resolved.platforms.includes(platform),
  );
  if (missingPlatforms.length > 0 && artifact.platformException === undefined) {
    throw new Error(`${artifact.key}: missing required platforms: ${missingPlatforms.join(', ')}`);
  }
  artifact.digest = resolved.digest;
  artifact.mediaType = resolved.mediaType;
  artifact.platforms = resolved.platforms;
  artifact.registry = resolved.registry;
  artifact.repository = resolved.repository;
  artifact.sourceTag = resolved.sourceTag;
  artifact.resolvedAt = new Date().toISOString();
  artifact.upstreamVerification = resolved.upstreamVerification;
}

lock.resolvedAt = new Date().toISOString();
const prettierConfig = (await resolveConfig(lockPath)) ?? {};
await writeFile(
  lockPath,
  await format(JSON.stringify(lock), { ...prettierConfig, parser: 'json' }),
);

async function resolveReference(source) {
  const parsed = parseReference(source);
  const manifestUrl = `https://${parsed.apiHost}/v2/${parsed.repository}/manifests/${parsed.selector}`;
  const manifestResponse = await authorizedFetch(manifestUrl, {
    headers: {
      accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(', '),
    },
  });
  if (!manifestResponse.response.ok) {
    throw new Error(`${source}: registry returned HTTP ${manifestResponse.response.status}`);
  }

  const manifestBytes = Buffer.from(await manifestResponse.response.arrayBuffer());
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const digest =
    manifestResponse.response.headers.get('docker-content-digest') ??
    `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;
  if (parsed.digest !== null && digest !== parsed.digest) {
    throw new Error(`${source}: registry digest ${digest} does not match pinned ${parsed.digest}`);
  }

  const mediaType = manifest.mediaType ?? manifestResponse.response.headers.get('content-type');
  let platforms;
  if (Array.isArray(manifest.manifests)) {
    platforms = manifest.manifests
      .map((entry) => platformName(entry.platform))
      .filter((platform) => platform !== null);
  } else {
    const configUrl = `https://${parsed.apiHost}/v2/${parsed.repository}/blobs/${manifest.config.digest}`;
    const configResponse = await authorizedFetch(configUrl, {
      token: manifestResponse.token,
    });
    if (!configResponse.response.ok) {
      throw new Error(`${source}: config returned HTTP ${configResponse.response.status}`);
    }
    const config = await configResponse.response.json();
    platforms = [platformName(config)].filter((platform) => platform !== null);
  }

  const upstreamVerification = await inspectReferrers(parsed, digest, manifestResponse.token);
  return {
    digest,
    mediaType,
    platforms: [...new Set(platforms)].sort(),
    registry: parsed.registry,
    repository: parsed.repository,
    sourceTag: parsed.tag,
    upstreamVerification,
  };
}

async function inspectReferrers(parsed, digest, token) {
  const checkedAt = new Date().toISOString();
  const url = `https://${parsed.apiHost}/v2/${parsed.repository}/referrers/${digest}`;
  try {
    const { response } = await authorizedFetch(url, {
      headers: { accept: 'application/vnd.oci.image.index.v1+json' },
      token,
    });
    if (!response.ok) {
      return {
        artifactTypes: [],
        checkedAt,
        method: 'oci-referrers-api',
        referrerCount: 0,
        status: `registry-http-${response.status}`,
      };
    }
    const payload = await response.json();
    const descriptors = Array.isArray(payload.manifests) ? payload.manifests : [];
    const artifactTypes = [
      ...new Set(
        descriptors
          .map((descriptor) => descriptor.artifactType ?? descriptor.mediaType)
          .filter((value) => typeof value === 'string'),
      ),
    ].sort();
    return {
      artifactTypes,
      checkedAt,
      method: 'oci-referrers-api',
      referrerCount: descriptors.length,
      status: descriptors.length === 0 ? 'none-published' : 'referrers-present-unverified',
    };
  } catch (error) {
    return {
      artifactTypes: [],
      checkedAt,
      method: 'oci-referrers-api',
      reason: error instanceof Error ? error.name : 'unknown-error',
      referrerCount: 0,
      status: 'request-failed',
    };
  }
}

async function authorizedFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  let response = await fetch(url, { headers });
  if (response.status !== 401) return { response, token: options.token };

  const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
  if (challenge === null) return { response, token: undefined };
  const tokenUrl = new URL(challenge.realm);
  if (challenge.service !== undefined) tokenUrl.searchParams.set('service', challenge.service);
  if (challenge.scope !== undefined) tokenUrl.searchParams.set('scope', challenge.scope);
  const tokenResponse = await fetch(tokenUrl);
  if (!tokenResponse.ok) {
    throw new Error(`${url}: registry token endpoint returned HTTP ${tokenResponse.status}`);
  }
  const tokenPayload = await tokenResponse.json();
  const token = tokenPayload.token ?? tokenPayload.access_token;
  if (typeof token !== 'string') throw new Error(`${url}: registry token response had no token`);
  headers.set('authorization', `Bearer ${token}`);
  response = await fetch(url, { headers });
  return { response, token };
}

function parseReference(source) {
  const digestSeparator = source.indexOf('@');
  const withoutDigest = digestSeparator === -1 ? source : source.slice(0, digestSeparator);
  const digest = digestSeparator === -1 ? null : source.slice(digestSeparator + 1);
  const slash = withoutDigest.indexOf('/');
  if (slash === -1) throw new Error(`${source}: registry host is required`);
  const registry = withoutDigest.slice(0, slash);
  const repositoryAndTag = withoutDigest.slice(slash + 1);
  const lastSlash = repositoryAndTag.lastIndexOf('/');
  const colon = repositoryAndTag.lastIndexOf(':');
  const hasTag = colon > lastSlash;
  const repository = hasTag ? repositoryAndTag.slice(0, colon) : repositoryAndTag;
  const tag = hasTag ? repositoryAndTag.slice(colon + 1) : digest === null ? 'latest' : null;
  return {
    apiHost: registry === 'docker.io' ? 'registry-1.docker.io' : registry,
    digest,
    registry,
    repository,
    selector: digest ?? tag,
    tag,
  };
}

function parseBearerChallenge(header) {
  if (header === null || !header.startsWith('Bearer ')) return null;
  const values = {};
  for (const match of header.slice(7).matchAll(/([a-z]+)="([^"]+)"/g)) {
    values[match[1]] = match[2];
  }
  return typeof values.realm === 'string' ? values : null;
}

function platformName(platform) {
  if (typeof platform?.os !== 'string' || typeof platform?.architecture !== 'string') return null;
  if (platform.os === 'unknown' || platform.architecture === 'unknown') return null;
  return `${platform.os}/${platform.architecture}`;
}
