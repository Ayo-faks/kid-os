import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { type FastifyRequest } from 'fastify';
import { catchError, from, mergeMap, Observable, throwError } from 'rxjs';

import { PrismaService } from '../prisma/prisma.service.js';

const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (readMethods.has(request.method.toUpperCase()) || request.tenant === undefined) {
      return next.handle();
    }

    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        await this.writeAuditEvent(request, 'completed');
        return body;
      }),
      catchError((error: unknown) =>
        from(this.writeAuditEvent(request, 'failed')).pipe(mergeMap(() => throwError(() => error))),
      ),
    );
  }

  private async writeAuditEvent(
    request: FastifyRequest,
    outcome: 'completed' | 'failed',
  ): Promise<void> {
    if (request.tenant === undefined) {
      return;
    }

    const tenant = request.tenant;

    try {
      await this.prisma.withTenantContext(
        {
          actor: {
            correlationId: tenant.correlationId,
            kind: 'user',
            userId: tenant.actorUserId,
          },
          homeId: tenant.homeId,
          tenantId: tenant.tenantId,
        },
        (transaction) => transaction.$executeRaw`
          INSERT INTO audit.events (
            tenant_id,
            home_id,
            actor_kind,
            actor_user_id,
            correlation_id,
            action,
            subject_type,
            subject_id,
            metadata
          )
          VALUES (
            ${tenant.tenantId}::uuid,
            ${tenant.homeId}::uuid,
            'user',
            ${tenant.actorUserId}::uuid,
            ${tenant.correlationId},
            ${request.method.toUpperCase()},
            'http_request',
            ${randomUUID()}::uuid,
            ${JSON.stringify({ outcome, path: request.url })}::jsonb
          )
        `,
      );
    } catch (error) {
      this.logger.warn({ error }, 'Failed to write audit event.');
    }
  }
}
