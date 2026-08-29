import { Module } from '@nestjs/common';

import { TemporalModule } from '../temporal/temporal.module.js';
import { UsersModule } from '../users/users.module.js';

import { EmailDraftsController } from './email-drafts.controller.js';
import { EmailDraftsService } from './email-drafts.service.js';

@Module({
  controllers: [EmailDraftsController],
  imports: [TemporalModule, UsersModule],
  providers: [EmailDraftsService],
})
export class EmailDraftsModule {}
