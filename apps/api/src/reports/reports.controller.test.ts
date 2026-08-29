import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { ROLES_KEY, type CareosRole } from '../common/roles.decorator.js';

import { ReportsController } from './reports.controller.js';

const ALL_CARE_ROLES: readonly CareosRole[] = [
  'support_worker',
  'key_worker',
  'shift_lead',
  'manager',
  'safeguarding_lead',
  'ops_admin',
];

const EXPORT_ROLES: readonly CareosRole[] = ['manager', 'safeguarding_lead', 'ops_admin'];

describe('ReportsController role boundaries', () => {
  it.each(['byType', 'byHome', 'byMonth'] as const)(
    'allows every care role to view %s aggregates',
    (method) => {
      expect(rolesFor(method)).toEqual(ALL_CARE_ROLES);
    },
  );

  it('keeps CSV export privileged', () => {
    expect(rolesFor('exportCsv')).toEqual(EXPORT_ROLES);
  });
});

function rolesFor(
  method: 'byType' | 'byHome' | 'byMonth' | 'exportCsv',
): readonly CareosRole[] | undefined {
  const handler: unknown = Object.getOwnPropertyDescriptor(
    ReportsController.prototype,
    method,
  )?.value;
  if (typeof handler !== 'function') throw new Error(`Missing report handler: ${method}`);
  return Reflect.getMetadata(ROLES_KEY, handler) as readonly CareosRole[] | undefined;
}
