import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = Symbol('CAREOS_ROLES');

export type CareosRole =
  | 'support_worker'
  | 'key_worker'
  | 'shift_lead'
  | 'manager'
  | 'safeguarding_lead'
  | 'ops_admin';

export const Roles = (...roles: readonly CareosRole[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(ROLES_KEY, roles);
