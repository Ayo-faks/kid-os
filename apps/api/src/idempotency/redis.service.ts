import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379/0', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
