import { createHash, randomUUID } from 'node:crypto';

import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { catchError, from, mergeMap, Observable, of, throwError } from 'rxjs';

import { firstHeader } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { RedisService } from './redis.service.js';

const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const excludedPrefixes = ['/mcp', '/health', '/ready', '/openapi'];
const excludedPaths = new Set(['/assistant/messages', '/incidents/draft-from-text']);

interface ReplayIdentity {
  readonly method: string;
  readonly path: string;
  readonly requestHash: string;
}

interface CachedResponse extends ReplayIdentity {
  readonly body: unknown;
  readonly status: number;
}

interface StoredReplayRecord {
  readonly expires_at: Date;
  readonly method: string;
  readonly path: string;
  readonly request_hash: string;
  readonly response_body: unknown;
  readonly response_status: number;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(RedisService)
    private readonly redis: RedisService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const method = request.method.toUpperCase();

    if (!writeMethods.has(method) || this.isExcluded(request.url)) {
      return next.handle();
    }

    if (request.tenant === undefined) {
      return next.handle();
    }

    const idempotencyKey = firstHeader(request, 'idempotency-key');

    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new HttpException('Missing Idempotency-Key header.', 428);
    }

    const tenant = request.tenant;
    const identity: ReplayIdentity = {
      method,
      path: request.url,
      requestHash: this.hashRequest(request.body),
    };
    const cacheKey = `idempotency:${request.tenant.tenantId}:${idempotencyKey}`;
    const cached = await this.redis.client.get(cacheKey);

    if (cached !== null) {
      const cachedResponse = JSON.parse(cached) as CachedResponse;
      this.assertIdentityMatches(cachedResponse, identity);
      reply.status(cachedResponse.status);
      return of(cachedResponse.body);
    }

    const stored = await this.findReplayRecord({
      actorUserId: tenant.actorUserId,
      correlationId: tenant.correlationId,
      homeId: tenant.homeId,
      idempotencyKey,
      tenantId: tenant.tenantId,
    });

    if (stored !== null) {
      const storedIdentity: ReplayIdentity = {
        method: stored.method,
        path: stored.path,
        requestHash: stored.request_hash,
      };
      this.assertIdentityMatches(storedIdentity, identity);
      const storedResponse: CachedResponse = {
        ...storedIdentity,
        body: stored.response_body,
        status: stored.response_status,
      };
      await this.cacheReplay(cacheKey, storedResponse, stored.expires_at);
      reply.status(storedResponse.status);
      return of(storedResponse.body);
    }

    const lockKey = `${cacheKey}:in-progress`;
    const lockToken = randomUUID();
    const claimed = await this.redis.client.set(lockKey, lockToken, 'EX', 60, 'NX');

    if (claimed !== 'OK') {
      throw new ConflictException('A request with this Idempotency-Key is already in progress.');
    }

    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        const status = reply.statusCode;

        await this.persistReplayRecord({
          actorUserId: tenant.actorUserId,
          body,
          cacheKey,
          correlationId: tenant.correlationId,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          homeId: tenant.homeId,
          idempotencyKey,
          ...identity,
          status,
          tenantId: tenant.tenantId,
        });
        await this.releaseLock(lockKey, lockToken);

        return body;
      }),
      catchError((error: unknown) =>
        from(this.releaseLock(lockKey, lockToken)).pipe(mergeMap(() => throwError(() => error))),
      ),
    );
  }

  private isExcluded(url: string): boolean {
    const path = url.split('?', 1)[0] ?? url;
    return excludedPaths.has(path) || excludedPrefixes.some((prefix) => path.startsWith(prefix));
  }

  private hashRequest(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
  }

  private assertIdentityMatches(actual: ReplayIdentity, expected: ReplayIdentity): void {
    if (
      actual.method !== expected.method ||
      actual.path !== expected.path ||
      actual.requestHash !== expected.requestHash
    ) {
      throw new ConflictException(
        'Idempotency-Key was already used for a different method, path, or request body.',
      );
    }
  }

  private async findReplayRecord(input: {
    readonly actorUserId: string;
    readonly correlationId: string;
    readonly homeId: string;
    readonly idempotencyKey: string;
    readonly tenantId: string;
  }): Promise<StoredReplayRecord | null> {
    const rows = await this.prisma.withTenantContext(
      {
        actor: {
          correlationId: input.correlationId,
          kind: 'user',
          userId: input.actorUserId,
        },
        homeId: input.homeId,
        tenantId: input.tenantId,
      },
      (transaction) => transaction.$queryRaw<StoredReplayRecord[]>`
        SELECT method, path, request_hash, response_status, response_body, expires_at
        FROM core.idempotency_keys
        WHERE tenant_id = ${input.tenantId}::uuid
          AND key = ${input.idempotencyKey}
          AND expires_at > now()
        LIMIT 1
      `,
    );

    return rows[0] ?? null;
  }

  private async persistReplayRecord(input: {
    readonly actorUserId: string;
    readonly body: unknown;
    readonly cacheKey: string;
    readonly correlationId: string;
    readonly expiresAt: Date;
    readonly homeId: string;
    readonly idempotencyKey: string;
    readonly method: string;
    readonly path: string;
    readonly requestHash: string;
    readonly status: number;
    readonly tenantId: string;
  }): Promise<void> {
    const record = await this.prisma.withTenantContext(
      {
        actor: {
          correlationId: input.correlationId,
          kind: 'user',
          userId: input.actorUserId,
        },
        homeId: input.homeId,
        tenantId: input.tenantId,
      },
      async (transaction) => {
        await transaction.$executeRaw`
          INSERT INTO core.idempotency_keys (
            id,
            tenant_id,
            key,
            method,
            path,
            request_hash,
            response_status,
            response_body,
            created_at,
            expires_at
          )
          VALUES (
            ${randomUUID()}::uuid,
            ${input.tenantId}::uuid,
            ${input.idempotencyKey},
            ${input.method},
            ${input.path},
            ${input.requestHash},
            ${input.status},
            ${JSON.stringify(input.body)}::jsonb,
            now(),
            ${input.expiresAt}
          )
          ON CONFLICT (tenant_id, key) DO NOTHING
        `;

        const rows = await transaction.$queryRaw<StoredReplayRecord[]>`
          SELECT method, path, request_hash, response_status, response_body, expires_at
          FROM core.idempotency_keys
          WHERE tenant_id = ${input.tenantId}::uuid
            AND key = ${input.idempotencyKey}
          LIMIT 1
        `;
        return rows[0];
      },
    );

    if (record === undefined) {
      throw new Error('Failed to persist idempotency replay record.');
    }

    const storedIdentity: ReplayIdentity = {
      method: record.method,
      path: record.path,
      requestHash: record.request_hash,
    };
    this.assertIdentityMatches(storedIdentity, input);
    await this.cacheReplay(
      input.cacheKey,
      {
        ...storedIdentity,
        body: record.response_body,
        status: record.response_status,
      },
      record.expires_at,
    );
  }

  private async cacheReplay(
    cacheKey: string,
    response: CachedResponse,
    expiresAt: Date,
  ): Promise<void> {
    const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    await this.redis.client.set(cacheKey, JSON.stringify(response), 'EX', ttlSeconds);
  }

  private async releaseLock(lockKey: string, lockToken: string): Promise<void> {
    try {
      await this.redis.client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockToken,
      );
    } catch (error) {
      this.logger.warn({ error }, 'Failed to release idempotency lock.');
    }
  }
}
