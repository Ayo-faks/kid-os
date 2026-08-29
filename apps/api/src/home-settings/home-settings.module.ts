import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { UsersModule } from '../users/users.module.js';

import { HomeSettingsController } from './home-settings.controller.js';
import { HomeSettingsService } from './home-settings.service.js';

@Module({
  controllers: [HomeSettingsController],
  exports: [HomeSettingsService],
  imports: [PrismaModule, UsersModule],
  providers: [HomeSettingsService],
})
export class HomeSettingsModule {}
