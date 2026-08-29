// Realm-parity contract test (REL-003).
//
// The Keycloak realm import and the demo seed must agree on every identity:
// tenant UUID, home UUIDs, user subs, role names, and home memberships.
// A mismatch here is exactly the class of bug that made first login fail when
// the realm carried string claims (`tenant-careos`) while RLS cast to uuid.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

interface SeedUser {
  readonly id: string;
  readonly keycloakSub: string;
  readonly email: string;
  readonly roles: readonly string[];
  readonly homeIds: readonly string[];
}

interface SeedData {
  readonly tenant: { readonly id: string; readonly name: string };
  readonly homes: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly users: readonly SeedUser[];
  readonly residents: ReadonlyArray<{ readonly id: string; readonly homeId: string }>;
  readonly shifts: ReadonlyArray<{
    readonly id: string;
    readonly homeId: string;
    readonly assignedUserIds: readonly string[];
  }>;
  readonly rotaRules: ReadonlyArray<{ readonly id: string; readonly homeId: string }>;
}

interface RealmUser {
  readonly id?: string;
  readonly username: string;
  readonly enabled: boolean;
  readonly attributes: {
    readonly tenant_id: readonly string[];
    readonly home_ids: readonly string[];
  };
  readonly realmRoles: readonly string[];
}

interface Realm {
  readonly clients: ReadonlyArray<{
    readonly clientId: string;
    readonly protocolMappers?: ReadonlyArray<{
      readonly name: string;
      readonly protocolMapper: string;
      readonly config?: Record<string, string>;
    }>;
  }>;
  readonly users: readonly RealmUser[];
  readonly roles: { readonly realm: ReadonlyArray<{ readonly name: string }> };
  readonly groups: ReadonlyArray<{
    readonly attributes?: Record<string, readonly string[]>;
    readonly subGroups?: ReadonlyArray<{ readonly attributes?: Record<string, readonly string[]> }>;
  }>;
}

const seed = JSON.parse(readFileSync(resolve(here, '..', 'seed-data.json'), 'utf8')) as SeedData;
const realm = JSON.parse(
  readFileSync(resolve(repoRoot, 'infra', 'keycloak', 'careos-realm.json'), 'utf8'),
) as Realm;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Keycloak realm ↔ demo seed parity', () => {
  it('uses valid UUIDs for every seeded identity', () => {
    expect(seed.tenant.id).toMatch(UUID_RE);
    for (const home of seed.homes) expect(home.id).toMatch(UUID_RE);
    for (const user of seed.users) {
      expect(user.id).toMatch(UUID_RE);
      expect(user.keycloakSub).toMatch(UUID_RE);
    }
  });

  it('realm tenant_id claims equal the seeded tenant UUID for every user', () => {
    for (const user of realm.users) {
      expect(user.attributes.tenant_id, user.username).toEqual([seed.tenant.id]);
    }
  });

  it('realm home_ids claims reference only seeded home UUIDs', () => {
    const homeIds = new Set(seed.homes.map((h) => h.id));
    for (const user of realm.users) {
      for (const homeId of user.attributes.home_ids) {
        expect(homeIds.has(homeId), `${user.username} → ${homeId}`).toBe(true);
      }
    }
  });

  it('every realm user has a matching seed user (sub, roles, homes)', () => {
    const seedBySub = new Map(seed.users.map((u) => [u.keycloakSub, u]));
    expect(realm.users.length).toBe(seed.users.length);
    for (const realmUser of realm.users) {
      expect(realmUser.id, `${realmUser.username} must carry a fixed id`).toBeDefined();
      const seedUser = seedBySub.get(realmUser.id ?? '');
      expect(seedUser, `${realmUser.username} missing from seed-data.json`).toBeDefined();
      expect(seedUser?.email).toBe(realmUser.username);
      expect([...(seedUser?.roles ?? [])].sort()).toEqual([...realmUser.realmRoles].sort());
      expect([...(seedUser?.homeIds ?? [])].sort()).toEqual(
        [...realmUser.attributes.home_ids].sort(),
      );
    }
  });

  it('seed covers the roles required by the safeguarding dual sign-off policy', () => {
    const seededRoles = new Set(seed.users.flatMap((u) => u.roles));
    for (const required of ['manager', 'safeguarding_lead', 'support_worker', 'ops_admin']) {
      expect(seededRoles.has(required), `missing seeded role: ${required}`).toBe(true);
    }
  });

  it('includes stable user subjects in access tokens for every CareOS client', () => {
    for (const clientId of ['web', 'api', 'mcp']) {
      const client = realm.clients.find((candidate) => candidate.clientId === clientId);
      const mapper = client?.protocolMappers?.find(
        (candidate) => candidate.protocolMapper === 'oidc-sub-mapper',
      );
      expect(mapper, `${clientId} subject mapper`).toBeDefined();
      expect(mapper?.config?.['access.token.claim']).toBe('true');
    }
  });

  it('realm groups carry UUID tenant/home attributes (no legacy string slugs)', () => {
    const legacy = /^(tenant-|home-)/;
    for (const group of realm.groups) {
      for (const values of Object.values(group.attributes ?? {})) {
        for (const value of values) expect(value).not.toMatch(legacy);
      }
      for (const sub of group.subGroups ?? []) {
        for (const values of Object.values(sub.attributes ?? {})) {
          for (const value of values) expect(value).not.toMatch(legacy);
        }
      }
    }
  });

  it('seed references are internally consistent (residents/shifts/rules → homes/users)', () => {
    const homeIds = new Set(seed.homes.map((h) => h.id));
    const userIds = new Set(seed.users.map((u) => u.id));
    for (const resident of seed.residents) {
      expect(homeIds.has(resident.homeId), `resident ${resident.id}`).toBe(true);
    }
    for (const rule of seed.rotaRules) {
      expect(homeIds.has(rule.homeId), `rule ${rule.id}`).toBe(true);
    }
    for (const shift of seed.shifts) {
      expect(homeIds.has(shift.homeId), `shift ${shift.id}`).toBe(true);
      for (const userId of shift.assignedUserIds) {
        expect(userIds.has(userId), `shift ${shift.id} → ${userId}`).toBe(true);
      }
    }
  });
});
