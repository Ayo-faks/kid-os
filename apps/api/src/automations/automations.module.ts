import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';

import { AutomationsController } from './automations.controller.js';
import { AutomationsService } from './automations.service.js';

@Module({
  controllers: [AutomationsController],
  exports: [AutomationsService],
  imports: [PrismaModule],
  providers: [AutomationsService],
})
export class AutomationsModule {}
