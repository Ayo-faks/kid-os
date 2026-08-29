import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TemporalModule } from '../temporal/temporal.module.js';
import { UsersModule } from '../users/users.module.js';

import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

@Module({
  controllers: [DocumentsController],
  imports: [PrismaModule, StorageModule, TemporalModule, UsersModule],
  providers: [DocumentsService],
})
export class DocumentsModule {}
