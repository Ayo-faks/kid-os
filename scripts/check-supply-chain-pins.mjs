#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const requireFromContracts = createRequire(
  new URL('../packages/contracts/package.json', import.meta.url),
);
const { parse: parseYaml } = requireFromContracts('yaml');
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const lockPath = 'infra/vendor-images.lock.json';
const errors = [];
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));

for (const [selector, fixedVersion] of [
  ['fast-uri@2.4.0', '2.4.4'],
  ['fast-uri@3.1.2', '3.1.5'],
  ['fast-uri@3.1.4', '3.1.5'],
  ['fast-uri@4.1.1', '4.1.2'],
]) {
  if (packageManifest.pnpm?.overrides?.[selector] !== fixedVersion) {
    errors.push(`package.json: ${selector} must remain pinned to ${fixedVersion}`);
  }
}

if (lock.schemaVersion !== 1) errors.push(`${lockPath}: schemaVersion must be 1`);
if (!Array.isArray(lock.artifacts) || lock.artifacts.length === 0) {
  errors.push(`${lockPath}: artifacts must be a non-empty array`);
}

const artifacts = new Map();
for (const artifact of lock.artifacts ?? []) {
  if (typeof artifact.key !== 'string' || artifact.key.length === 0) {
    errors.push(`${lockPath}: artifact key is missing`);
    continue;
  }
  if (artifacts.has(artifact.key)) errors.push(`${artifact.key}: duplicate artifact key`);
  artifacts.set(artifact.key, artifact);
  if (!digestPattern.test(artifact.digest ?? '')) errors.push(`${artifact.key}: invalid digest`);
  if (typeof artifact.resolvedAt !== 'string' || Number.isNaN(Date.parse(artifact.resolvedAt))) {
    errors.push(`${artifact.key}: resolvedAt is missing or invalid`);
  }
  if (!Array.isArray(artifact.platforms) || artifact.platforms.length === 0) {
    errors.push(`${artifact.key}: platforms are missing`);
  }
  if (!Array.isArray(artifact.requiredPlatforms) || artifact.requiredPlatforms.length === 0) {
    errors.push(`${artifact.key}: requiredPlatforms are missing`);
  }
  if (!Array.isArray(artifact.usedBy) || artifact.usedBy.length === 0) {
    errors.push(`${artifact.key}: usedBy is missing`);
  }
  const verification = artifact.upstreamVerification;
  if (
    verification?.method !== 'oci-referrers-api' ||
    typeof verification?.status !== 'string' ||
    !Number.isInteger(verification?.referrerCount) ||
    typeof verification?.checkedAt !== 'string' ||
    Number.isNaN(Date.parse(verification.checkedAt)) ||
    !Array.isArray(verification?.artifactTypes)
  ) {
    errors.push(`${artifact.key}: upstream signature/provenance result is missing`);
  } else if (verification.status === 'request-failed') {
    errors.push(`${artifact.key}: upstream signature/provenance request failed`);
  }

  const missing = (artifact.requiredPlatforms ?? []).filter(
    (platform) => !(artifact.platforms ?? []).includes(platform),
  );
  const allowedMissing = artifact.platformException?.allowedMissingPlatforms ?? [];
  if (missing.length > 0 && !sameMembers(missing, allowedMissing)) {
    errors.push(`${artifact.key}: missing platforms are not exactly covered by its exception`);
  }
  if (missing.length === 0 && artifact.platformException !== undefined) {
    errors.push(
      `${artifact.key}: platform exception is present but no required platform is missing`,
    );
  }
  if (missing.length > 0 && !nonEmptyString(artifact.platformException?.handling)) {
    errors.push(`${artifact.key}: platform exception handling is missing`);
  }
  if (
    artifact.optionalService !== undefined &&
    (!nonEmptyString(artifact.optionalService.profile) ||
      !nonEmptyString(artifact.optionalService.reason))
  ) {
    errors.push(`${artifact.key}: optional service profile metadata is invalid`);
  }
}

const composePath = 'infra/compose/docker-compose.yml';
const compose = parseYaml(await readFile(composePath, 'utf8'));
for (const [serviceName, service] of Object.entries(compose.services ?? {})) {
  if (typeof service.image !== 'string') continue;
  const artifact = artifactForUsage(`${composePath}#${serviceName}`);
  if (artifact === undefined) continue;
  comparePinnedReference(`${composePath}#${serviceName}`, service.image, artifact);
  const missing = artifact.requiredPlatforms.filter(
    (platform) => !artifact.platforms.includes(platform),
  );
  if (missing.length > 0 && (!Array.isArray(service.profiles) || service.profiles.length === 0)) {
    errors.push(`${composePath}#${serviceName}: platform-limited image must be profile-gated`);
  }
  if (artifact.optionalService !== undefined) {
    const expectedProfile = artifact.optionalService.profile;
    if (!Array.isArray(service.profiles) || !service.profiles.includes(expectedProfile)) {
      errors.push(`${composePath}#${serviceName}: optional profile differs from lock`);
    }
  }
}

const keycloakService = compose.services?.keycloak;
if (
  keycloakService?.build?.context !== '../keycloak' ||
  keycloakService.build.dockerfile !== 'Dockerfile'
) {
  errors.push(`${composePath}#keycloak: optimized local image build is required`);
}
if (
  !Array.isArray(keycloakService?.command) ||
  !keycloakService.command.includes('start') ||
  !keycloakService.command.includes('--optimized') ||
  keycloakService.command.includes('start-dev') ||
  keycloakService.command.some((argument) => argument.startsWith('--http-relative-path'))
) {
  errors.push(`${composePath}#keycloak: optimized startup command is invalid`);
}
if (
  !Array.isArray(keycloakService?.volumes) ||
  !keycloakService.volumes.includes(
    '../keycloak/careos-realm.json:/opt/keycloak/data/import/careos-realm.json:ro',
  ) ||
  keycloakService.volumes.some((volume) =>
    String(volume).includes('../keycloak:/opt/keycloak/data/import'),
  )
) {
  errors.push(`${composePath}#keycloak: only the reviewed realm JSON may be import-mounted`);
}

const keycloakDockerfilePath = 'infra/keycloak/Dockerfile';
const keycloakDockerfile = await readFile(keycloakDockerfilePath, 'utf8');
for (const requirement of [
  'KC_DB=postgres',
  'KC_HEALTH_ENABLED=true',
  'KC_HTTP_RELATIVE_PATH=/keycloak',
  'KC_METRICS_ENABLED=true',
  'RUN /opt/keycloak/bin/kc.sh build',
  'COPY --from=builder /opt/keycloak/ /opt/keycloak/',
  'mkdir -p /opt/keycloak/data/import',
  'chown 1000:0 /opt/keycloak/data/import',
  'chmod 0750 /opt/keycloak/data/import',
  'rm -rf /opt/keycloak/bin/client',
  'com.microsoft.sqlserver.mssql-jdbc-13.2.1.jre11.jar',
  'com.fasterxml.jackson.core.jackson-core-2.21.2.jar',
  'com.fasterxml.jackson.core.jackson-databind-2.21.2.jar',
  'io.micrometer.micrometer-core-1.16.3.jar',
  'org.postgresql.postgresql-42.7.11.jar',
]) {
  if (!keycloakDockerfile.includes(requirement)) {
    errors.push(`${keycloakDockerfilePath}: missing optimized build requirement ${requirement}`);
  }
}

const keycloakPatchLockPath = 'infra/keycloak/dependency-patches.lock.json';
const keycloakPatchLock = JSON.parse(await readFile(keycloakPatchLockPath, 'utf8'));
if (
  keycloakPatchLock.schemaVersion !== 1 ||
  !Array.isArray(keycloakPatchLock.artifacts) ||
  keycloakPatchLock.artifacts.length !== 20
) {
  errors.push(`${keycloakPatchLockPath}: expected 20 versioned patch artifacts`);
} else {
  const patchFileNames = new Set();
  for (const artifact of keycloakPatchLock.artifacts) {
    if (
      !/^[A-Za-z0-9.-]+\.jar$/.test(artifact.fileName ?? '') ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? '')
    ) {
      errors.push(`${keycloakPatchLockPath}: invalid patch artifact name or checksum`);
      continue;
    }
    if (patchFileNames.has(artifact.fileName)) {
      errors.push(`${keycloakPatchLockPath}: duplicate patch artifact ${artifact.fileName}`);
    }
    patchFileNames.add(artifact.fileName);
    let sourceUrl;
    try {
      sourceUrl = new URL(artifact.url);
    } catch {
      errors.push(`${keycloakPatchLockPath}: invalid URL for ${artifact.fileName}`);
      continue;
    }
    if (
      sourceUrl.protocol !== 'https:' ||
      sourceUrl.hostname !== 'repo.maven.apache.org' ||
      !sourceUrl.pathname.endsWith(`/${artifact.fileName}`)
    ) {
      errors.push(`${keycloakPatchLockPath}: unapproved source for ${artifact.fileName}`);
      continue;
    }
    const instruction = `ADD --checksum=sha256:${artifact.sha256} ${artifact.url} /tmp/jars/${artifact.fileName}`;
    if (!keycloakDockerfile.includes(instruction)) {
      errors.push(`${keycloakDockerfilePath}: patch differs from lock for ${artifact.fileName}`);
    }
  }
  const patchAddCount = keycloakDockerfile.match(/^ADD --checksum=sha256:/gm)?.length ?? 0;
  if (patchAddCount !== keycloakPatchLock.artifacts.length) {
    errors.push(`${keycloakDockerfilePath}: checksum-pinned patch count differs from lock`);
  }
}

const localOtelConfigPath = 'infra/otel/otel-collector.yaml';
const localOtelConfig = parseYaml(await readFile(localOtelConfigPath, 'utf8'));
const localLogExporters = localOtelConfig.service?.pipelines?.logs?.exporters ?? [];
if (
  localOtelConfig.exporters?.['otlphttp/loki']?.endpoint !== 'http://loki:3100/otlp' ||
  !localLogExporters.includes('otlphttp/loki') ||
  localOtelConfig.exporters?.loki !== undefined
) {
  errors.push(`${localOtelConfigPath}: logs must use Loki native OTLP ingestion`);
}
const lokiConfigPath = 'infra/loki/loki.yaml';
const lokiConfig = parseYaml(await readFile(lokiConfigPath, 'utf8'));
if (lokiConfig.limits_config?.allow_structured_metadata !== true) {
  errors.push(`${lokiConfigPath}: OTLP log ingestion requires structured metadata`);
}

for (const [dockerfilePath, requirement] of [
  [
    'infra/caddy/Dockerfile',
    'COPY --chown=caddy:caddy --chmod=0444 Caddyfile.azure /etc/caddy/Caddyfile',
  ],
  [
    keycloakDockerfilePath,
    'COPY --chown=1000:0 --chmod=0440 careos-realm.json /opt/keycloak/data/import/careos-realm.json',
  ],
  [
    'infra/otel/Dockerfile',
    'COPY --chown=10001:10001 --chmod=0444 otel-collector.azure.yaml /etc/otelcol-contrib/config.yaml',
  ],
]) {
  const dockerfile = await readFile(dockerfilePath, 'utf8');
  if (!dockerfile.includes(requirement)) {
    errors.push(`${dockerfilePath}: non-root runtime config ownership and mode are not pinned`);
  }
}

for (const dockerfile of await findFiles('.', (path) => path.endsWith('/Dockerfile'))) {
  const content = await readFile(dockerfile, 'utf8');
  for (const [index, line] of content.split('\n').entries()) {
    const trimmed = line.trim();
    if (!/^FROM\s+/i.test(trimmed)) continue;
    const match = /^FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+\S+)?$/i.exec(trimmed);
    if (match === null) {
      errors.push(`${dockerfile}:${index + 1}: FROM instruction could not be validated`);
      continue;
    }
    const reference = parseReference(match[1]);
    const candidates = [...artifacts.values()].filter(
      (item) =>
        item.usedBy.includes(dockerfile) &&
        item.registry === reference.registry &&
        item.repository === reference.repository,
    );
    if (candidates.length !== 1) {
      errors.push(`${dockerfile}:${index + 1}: no unambiguous lock artifact for FROM`);
      continue;
    }
    comparePinnedReference(`${dockerfile}:${index + 1}`, match[1], candidates[0]);
  }
}

const postgres = artifacts.get('postgres');
if (postgres === undefined) {
  errors.push('postgres: lock artifact is missing');
} else {
  const postgresHelperPath = 'apps/api/src/database/test-postgres-image.ts';
  const postgresHelper = await readFile(postgresHelperPath, 'utf8');
  const helperReferences = postgresHelper.match(/pgvector\/pgvector:[^'"\s]+/g) ?? [];
  if (helperReferences.length !== 1) {
    errors.push(`${postgresHelperPath}: expected one reviewed pgvector reference`);
  } else {
    comparePinnedReference(postgresHelperPath, helperReferences[0], postgres);
  }
  const integrationFiles = await findFiles('apps/api', (path) => path.endsWith('.test.ts'));
  const testcontainerFiles = [];
  for (const path of integrationFiles) {
    const content = await readFile(path, 'utf8');
    if (!content.includes('new GenericContainer')) continue;
    testcontainerFiles.push(path);
    if (!content.includes('resolveCareosTestPostgresImage()')) {
      errors.push(`${path}: Testcontainers image does not use the reviewed resolver`);
    }
    if (content.includes('process.env.CAREOS_TEST_POSTGRES_IMAGE')) {
      errors.push(`${path}: Testcontainers image bypasses the reviewed resolver`);
    }
  }
  if (testcontainerFiles.length !== 9) {
    errors.push(
      `Testcontainers: expected 9 PostgreSQL defaults, found ${testcontainerFiles.length}`,
    );
  }
}

const aptLockPath = 'infra/debian-snapshot.lock.json';
const aptLock = JSON.parse(await readFile(aptLockPath, 'utf8'));
if (aptLock.schemaVersion !== 1 || !/^\d{8}T\d{6}Z$/.test(aptLock.timestamp ?? '')) {
  errors.push(`${aptLockPath}: invalid schema or timestamp`);
}
if (
  aptLock.transport?.scheme !== 'http' ||
  aptLock.transport?.integrity !== 'apt-inrelease-signature' ||
  aptLock.transport?.signedBy !== '/usr/share/keyrings/debian-archive-keyring.gpg' ||
  !nonEmptyString(aptLock.transport?.reason)
) {
  errors.push(`${aptLockPath}: signed snapshot bootstrap transport is invalid`);
}
if (!Array.isArray(aptLock.usedBy) || aptLock.usedBy.length === 0) {
  errors.push(`${aptLockPath}: usedBy is missing`);
} else {
  const aptDockerfiles = [];
  for (const dockerfile of await findFiles('.', (path) => path.endsWith('/Dockerfile'))) {
    if ((await readFile(dockerfile, 'utf8')).includes('apt-get')) aptDockerfiles.push(dockerfile);
  }
  if (!sameMembers(aptLock.usedBy, aptDockerfiles)) {
    errors.push(`${aptLockPath}: usedBy differs from apt-using Dockerfiles`);
  }
  for (const dockerfile of aptLock.usedBy) {
    const content = await readFile(dockerfile, 'utf8');
    if (!content.includes(`ARG DEBIAN_SNAPSHOT=${aptLock.timestamp}`)) {
      errors.push(`${dockerfile}: Debian snapshot timestamp differs from lock`);
    }
    if (!content.includes('rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*')) {
      errors.push(`${dockerfile}: inherited mutable apt sources are not removed`);
    }
    for (const archive of ['debian', 'debian-security']) {
      if (!content.includes(`URIs: http://snapshot.debian.org/archive/${archive}/%s`)) {
        errors.push(`${dockerfile}: ${archive} snapshot source is missing`);
      }
    }
    const snapshotSourceCount = content.match(
      /URIs: http:\/\/snapshot\.debian\.org\/archive\/(?:debian|debian-security)\/%s/g,
    )?.length;
    const signedByCount = content.match(
      /Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring\.gpg/g,
    )?.length;
    if (signedByCount !== snapshotSourceCount) {
      errors.push(`${dockerfile}: every snapshot source must use the Debian archive keyring`);
    }
    if (
      /trusted=yes|allow-unauthenticated|AllowUnauthenticated|Verify-Peer\s+"?false/i.test(content)
    ) {
      errors.push(`${dockerfile}: unauthenticated apt bypass is forbidden`);
    }
    if (content.includes('deb.debian.org') || content.includes('security.debian.org')) {
      errors.push(`${dockerfile}: mutable Debian source is present`);
    }
  }
}

const agentDockerfile = await readFile('apps/agent/Dockerfile', 'utf8');
if (!agentDockerfile.includes('COPY requirements-lock.txt')) {
  errors.push('apps/agent/Dockerfile: requirements lock is not copied');
}
if (!agentDockerfile.includes('--require-hashes -r requirements-lock.txt')) {
  errors.push('apps/agent/Dockerfile: pip does not require hashes');
}
if (
  agentDockerfile.includes('pip install') &&
  agentDockerfile.match(/pip install/g)?.length !== 1
) {
  errors.push('apps/agent/Dockerfile: multiple pip install commands may bypass the hash lock');
}
if (agentDockerfile.includes('--editable') || agentDockerfile.includes('--no-build-isolation')) {
  errors.push(
    'apps/agent/Dockerfile: local package build is unnecessary and may fetch build dependencies',
  );
}
const requirementsLock = await readFile('apps/agent/requirements-lock.txt', 'utf8');
const runtimeRequirementCount = validatePythonLock(
  'apps/agent/requirements-lock.txt',
  requirementsLock,
);
const requirementsTestLockPath = 'apps/agent/requirements-test-lock.txt';
const requirementsTestLock = await readFile(requirementsTestLockPath, 'utf8');
const testRequirementCount = validatePythonLock(requirementsTestLockPath, requirementsTestLock);
if (!/^pytest==/m.test(requirementsTestLock)) {
  errors.push(`${requirementsTestLockPath}: pytest is missing`);
}

const modelLockPath = 'infra/ollama-model.lock.json';
const modelLock = JSON.parse(await readFile(modelLockPath, 'utf8'));
if (modelLock.schemaVersion !== 1 || !digestPattern.test(modelLock.manifestDigest ?? '')) {
  errors.push(`${modelLockPath}: schema or manifest digest is invalid`);
}
for (const [location, descriptor] of [
  ['config', modelLock.config],
  ...(modelLock.layers ?? []).map((layer, index) => [`layer[${index}]`, layer]),
]) {
  if (
    typeof descriptor?.mediaType !== 'string' ||
    !digestPattern.test(descriptor?.digest ?? '') ||
    !Number.isInteger(descriptor?.size) ||
    descriptor.size < 0
  ) {
    errors.push(`${modelLockPath}:${location}: invalid content descriptor`);
  }
}
if (!Array.isArray(modelLock.layers) || modelLock.layers.length === 0) {
  errors.push(`${modelLockPath}: layers are missing`);
}
const modelName = `${modelLock.repository.split('/').at(-1)}:${modelLock.tag}`;
const envExample = await readFile('.env.example', 'utf8');
if (!envExample.includes(`CAREOS_LLM_MODEL=${modelName}`)) {
  errors.push('.env.example: Ollama model tag differs from lock');
}
if (!envExample.includes(`OLLAMA_MODEL_MANIFEST_DIGEST=${modelLock.manifestDigest}`)) {
  errors.push('.env.example: Ollama manifest digest differs from lock');
}
const composeText = await readFile(composePath, 'utf8');
if (!composeText.includes(`OLLAMA_MODEL_MANIFEST_DIGEST:-${modelLock.manifestDigest}`)) {
  errors.push(`${composePath}: Ollama manifest digest differs from lock`);
}
if (
  !composeText.includes('model_name="$${CAREOS_LLM_MODEL%%:*}"') ||
  !composeText.includes('model_tag="$${CAREOS_LLM_MODEL#*:}"') ||
  !composeText.includes('test -f "$${manifest}"') ||
  !composeText.includes('sha256sum "$${manifest}"')
) {
  errors.push(`${composePath}: Ollama pull does not verify the installed manifest`);
}

const actionLockPath = '.github/actions.lock.json';
const actionLock = JSON.parse(await readFile(actionLockPath, 'utf8'));
if (actionLock.schemaVersion !== 1 || !Array.isArray(actionLock.actions)) {
  errors.push(`${actionLockPath}: unsupported schema`);
}
const actions = new Map();
for (const action of actionLock.actions ?? []) {
  if (!nonEmptyString(action.repository) || !nonEmptyString(action.sourceTag)) {
    errors.push(`${actionLockPath}: repository or sourceTag is missing`);
    continue;
  }
  if (actions.has(action.repository)) errors.push(`${action.repository}: duplicate action lock`);
  actions.set(action.repository, action);
  if (!/^[0-9a-f]{40}$/.test(action.commit ?? '')) {
    errors.push(`${action.repository}: invalid action commit`);
  }
  if (!Array.isArray(action.usedBy) || action.usedBy.length === 0) {
    errors.push(`${action.repository}: action usedBy is missing`);
  }
  if (typeof action.resolvedAt !== 'string' || Number.isNaN(Date.parse(action.resolvedAt))) {
    errors.push(`${action.repository}: action resolvedAt is missing or invalid`);
  }
}
const seenActions = new Set();
const workflowFiles = await findFiles('.github/workflows', (path) => /\.ya?ml$/.test(path));
for (const workflow of workflowFiles) {
  const content = await readFile(workflow, 'utf8');
  for (const [index, line] of content.split('\n').entries()) {
    if (!/^\s*uses:/.test(line) || line.includes('uses: ./')) continue;
    const match =
      /^\s*uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/[^@\s]+)?@([0-9a-f]{40})\s+#\s+(\S+)\s*$/.exec(
        line,
      );
    if (match === null) {
      errors.push(`${workflow}:${index + 1}: action must use a full SHA and source-tag comment`);
      continue;
    }
    const [, repository, commit, sourceTag] = match;
    const locked = actions.get(repository);
    if (locked === undefined) {
      errors.push(`${workflow}:${index + 1}: ${repository} is missing from action lock`);
      continue;
    }
    seenActions.add(repository);
    if (!locked.usedBy.includes(workflow)) {
      errors.push(`${workflow}:${index + 1}: ${repository} usage is not declared by action lock`);
    }
    if (commit !== locked.commit || sourceTag !== locked.sourceTag) {
      errors.push(`${workflow}:${index + 1}: ${repository} differs from action lock`);
    }
  }
}
for (const [repository, action] of actions) {
  const presentUsages = (action.usedBy ?? []).filter((path) => workflowFiles.includes(path));
  if (presentUsages.length > 0 && !seenActions.has(repository)) {
    errors.push(`${repository}: locked action is unused by its present workflow paths`);
  }
}

const terraformVendorMapPath = 'infra/vendor-images.terraform.json';
const terraformVendorMap = JSON.parse(await readFile(terraformVendorMapPath, 'utf8'));
const requiredTerraformVendors = [
  'docling',
  'gotenberg',
  'minio',
  'ollama',
  'temporal',
  'temporal-ui',
];
if (!sameMembers(Object.keys(terraformVendorMap), requiredTerraformVendors)) {
  errors.push(`${terraformVendorMapPath}: keys differ from the approved vendor set`);
}
for (const key of requiredTerraformVendors) {
  const artifact = artifacts.get(key);
  const expected =
    artifact === undefined
      ? null
      : `${artifact.registry}/${artifact.repository}@${artifact.digest}`;
  if (terraformVendorMap[key] !== expected) {
    errors.push(`${terraformVendorMapPath}:${key}: value differs from image lock`);
  }
}
const terraformFiles = await findFiles('infra/terraform', (path) => path.endsWith('.tf'));
if (terraformFiles.length > 0) {
  const referencedVendors = new Set();
  for (const path of terraformFiles) {
    const content = await readFile(path, 'utf8');
    for (const match of content.matchAll(/var\.vendor_images\["([^"]+)"\]/g)) {
      referencedVendors.add(match[1]);
    }
  }
  if (!sameMembers([...referencedVendors], requiredTerraformVendors)) {
    errors.push('infra/terraform: vendor_images references differ from the generated map');
  }
}

if (errors.length > 0) {
  console.error('Supply-chain pin check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Supply-chain pins passed (${artifacts.size} images, ${actions.size} actions, ${runtimeRequirementCount} runtime and ${testRequirementCount} test Python packages).`,
);

function artifactForUsage(usage) {
  const matches = [...artifacts.values()].filter((artifact) => artifact.usedBy.includes(usage));
  if (matches.length === 0) {
    errors.push(`${usage}: no vendor lock artifact declares this usage`);
    return undefined;
  }
  if (matches.length > 1) {
    errors.push(`${usage}: multiple vendor lock artifacts declare this usage`);
    return undefined;
  }
  return matches[0];
}

function comparePinnedReference(location, source, artifact) {
  let actual;
  let expected;
  try {
    actual = parseReference(source);
    expected = parseReference(artifact.source);
  } catch (error) {
    errors.push(`${location}: ${error.message}`);
    return;
  }
  if (!digestPattern.test(actual.digest ?? '')) errors.push(`${location}: digest is missing`);
  if (actual.digest !== artifact.digest) errors.push(`${location}: digest differs from lock`);
  if (actual.registry !== expected.registry || actual.repository !== expected.repository) {
    errors.push(`${location}: registry/repository differs from lock source`);
  }
  if (actual.tag !== expected.tag) errors.push(`${location}: source tag differs from lock`);
}

function parseReference(source) {
  const digestSeparator = source.indexOf('@');
  const withoutDigest = digestSeparator === -1 ? source : source.slice(0, digestSeparator);
  const digest = digestSeparator === -1 ? null : source.slice(digestSeparator + 1);
  const lastSlash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  const tag = colon > lastSlash ? withoutDigest.slice(colon + 1) : null;
  const withoutTag = tag === null ? withoutDigest : withoutDigest.slice(0, colon);
  const parts = withoutTag.split('/');
  let registry;
  let repository;
  if (parts.length === 1) {
    registry = 'docker.io';
    repository = `library/${parts[0]}`;
  } else if (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost') {
    registry = parts.shift();
    repository = parts.join('/');
  } else {
    registry = 'docker.io';
    repository = parts.join('/');
  }
  if (!nonEmptyString(repository)) throw new Error(`invalid image reference: ${source}`);
  return { digest, registry, repository, tag };
}

async function findFiles(root, predicate) {
  const result = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          ['.git', '.next', '.tmp', '.turbo', 'dist', 'node_modules', 'test-results'].includes(
            entry.name,
          )
        ) {
          continue;
        }
        await walk(path);
      } else if (entry.isFile()) {
        const normalized = relative('.', path).replaceAll('\\', '/');
        if (predicate(normalized)) result.push(normalized);
      }
    }
  }
  await walk(root);
  return result.sort();
}

function sameMembers(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((item, index) => item === [...right].sort()[index])
  );
}

function validatePythonLock(path, content) {
  const lines = content.split('\n').filter((line) => /^[a-zA-Z0-9_.-]+==/.test(line));
  if (lines.length === 0 || lines.some((line) => !line.includes('=='))) {
    errors.push(`${path}: exact dependency pins are missing`);
  }
  if (!content.includes('--hash=sha256:')) {
    errors.push(`${path}: hashes are missing`);
  }
  return lines.length;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
