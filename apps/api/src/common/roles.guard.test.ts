import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { Roles } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';

function makeContext(roles: readonly string[], handler: () => unknown): ExecutionContext {
  return {
    getClass: () => class C {},
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({ tenant: { roles } }),
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  class Controller {
    @Roles('manager', 'safeguarding_lead')
    approve(this: void): void {
      /* noop */
    }

    open(this: void): void {
      /* noop */
    }
  }

  const approveHandler: () => void = Controller.prototype.approve;
  const openHandler: () => void = Controller.prototype.open;

  it('allows requests with no @Roles metadata', () => {
    const ctx = makeContext(['support_worker'], openHandler);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows requests holding at least one required role', () => {
    const ctx = makeContext(['manager'], approveHandler);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects requests missing every required role', () => {
    const ctx = makeContext(['support_worker'], approveHandler);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
