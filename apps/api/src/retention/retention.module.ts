import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { TemporalModule } from '../temporal/temporal.module.js';
import { UsersModule } from '../users/users.module.js';

import { RetentionController } from './retention.controller.js';
import { RetentionService } from './retention.service.js';

@Module({
  controllers: [RetentionController],
  exports: [RetentionService],
  imports: [PrismaModule, TemporalModule, UsersModule],
  providers: [RetentionService],
})
export class RetentionModule {}
