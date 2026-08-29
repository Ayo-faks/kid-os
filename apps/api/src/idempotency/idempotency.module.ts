import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { PrismaModule } from '../prisma/prisma.module.js';

import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { RedisService } from './redis.service.js';

@Module({
  imports: [PrismaModule],
  providers: [
    RedisService,
    IdempotencyInterceptor,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
  exports: [RedisService],
})
export class IdempotencyModule {}
