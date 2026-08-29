import { Redis } from 'ioredis';

import type { BudgetStore } from './types.js';

const KEY_TTL_SECONDS = 40 * 24 * 60 * 60;

export class RedisBudgetStore implements BudgetStore {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  async addUsage(tenantId: string, bucket: string, tokens: number): Promise<number> {
    if (tokens <= 0) return this.getUsage(tenantId, bucket);
    await this.connectIfNeeded();
    const key = budgetKey(tenantId, bucket);
    const result = await this.redis.multi().incrby(key, tokens).expire(key, KEY_TTL_SECONDS).exec();
    const increment = result?.[0]?.[1];
    if (typeof increment !== 'number') throw new Error('Failed to record gateway token usage.');
    return increment;
  }

  async close(): Promise<void> {
    if (this.redis.status === 'end') return;
    await this.redis.quit();
  }

  async getUsage(tenantId: string, bucket: string): Promise<number> {
    await this.connectIfNeeded();
    const value = await this.redis.get(budgetKey(tenantId, bucket));
    return value === null ? 0 : Number(value);
  }

  private async connectIfNeeded(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
  }
}

function budgetKey(tenantId: string, bucket: string): string {
  return `careos:llm-budget:${tenantId}:${bucket}`;
}
