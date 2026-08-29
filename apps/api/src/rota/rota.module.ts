import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module.js';
import { TemporalModule } from '../temporal/temporal.module.js';
import { UsersModule } from '../users/users.module.js';

import { RotaController } from './rota.controller.js';
import { RotaService } from './rota.service.js';

@Module({
  controllers: [RotaController],
  imports: [PrismaModule, TemporalModule, UsersModule],
  providers: [RotaService],
})
export class RotaModule {}
