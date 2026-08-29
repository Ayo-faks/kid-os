import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TemporalModule } from '../temporal/temporal.module.js';
import { UsersModule } from '../users/users.module.js';

import { ExportBundlesController } from './export-bundles.controller.js';
import { ExportBundlesService } from './export-bundles.service.js';

@Module({
  controllers: [ExportBundlesController],
  exports: [ExportBundlesService],
  imports: [PrismaModule, StorageModule, TemporalModule, UsersModule],
  providers: [ExportBundlesService],
})
export class ExportBundlesModule {}
