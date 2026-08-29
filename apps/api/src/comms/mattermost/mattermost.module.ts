import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module.js';
import { UsersModule } from '../../users/users.module.js';

import { MattermostController } from './mattermost.controller.js';
import { MattermostService } from './mattermost.service.js';

@Module({
  controllers: [MattermostController],
  exports: [MattermostService],
  imports: [PrismaModule, UsersModule],
  providers: [MattermostService],
})
export class MattermostModule {}
