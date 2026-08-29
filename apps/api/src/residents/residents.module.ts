import { Module } from '@nestjs/common';

import { ResidentsController } from './residents.controller.js';
import { ResidentsService } from './residents.service.js';

@Module({
  controllers: [ResidentsController],
  providers: [ResidentsService],
  exports: [ResidentsService],
})
export class ResidentsModule {}
