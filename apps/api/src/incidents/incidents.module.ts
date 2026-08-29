import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TemporalModule } from '../temporal/temporal.module.js';
import { UsersModule } from '../users/users.module.js';

import { IncidentsController } from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';

@Module({
  controllers: [IncidentsController],
  imports: [ApprovalsModule, TemporalModule, UsersModule, StorageModule],
  providers: [IncidentsService],
})
export class IncidentsModule {}
