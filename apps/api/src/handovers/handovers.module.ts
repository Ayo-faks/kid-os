import { Module } from '@nestjs/common';

import { TemporalModule } from '../temporal/temporal.module.js';
import { UsersModule } from '../users/users.module.js';

import { HandoversController } from './handovers.controller.js';
import { HandoversService } from './handovers.service.js';

@Module({
  controllers: [HandoversController],
  imports: [TemporalModule, UsersModule],
  providers: [HandoversService],
})
export class HandoversModule {}
