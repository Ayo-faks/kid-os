import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';

import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  controllers: [ReportsController],
  exports: [ReportsService],
  imports: [PrismaModule],
  providers: [ReportsService],
})
export class ReportsModule {}
