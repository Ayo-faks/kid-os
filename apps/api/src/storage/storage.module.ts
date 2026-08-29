import { Module } from '@nestjs/common';

import { StorageService } from './storage.service.js';

@Module({
  exports: [StorageService],
  providers: [StorageService],
})
export class StorageModule {}
