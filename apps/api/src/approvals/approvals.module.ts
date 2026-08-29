import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { TemporalModule } from '../temporal/temporal.module.js';
import { UsersModule } from '../users/users.module.js';

import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';

@Module({
  controllers: [ApprovalsController],
  exports: [ApprovalsService],
  imports: [PrismaModule, TemporalModule, UsersModule],
  providers: [ApprovalsService],
})
export class ApprovalsModule {}
