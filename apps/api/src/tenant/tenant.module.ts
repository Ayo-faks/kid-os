import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { PrismaModule } from '../prisma/prisma.module.js';
import { UsersModule } from '../users/users.module.js';

import { TenantGuard } from './tenant.guard.js';

@Module({
  imports: [PrismaModule, UsersModule],
  providers: [
    TenantGuard,
    {
      provide: APP_GUARD,
      useExisting: TenantGuard,
    },
  ],
  exports: [TenantGuard],
})
export class TenantModule {}
