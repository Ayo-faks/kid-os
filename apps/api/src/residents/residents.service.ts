import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import type { ListResidentsResponse, ResidentResponse } from './dto.js';

interface ResidentRequestContext {
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly homeId: string;
  readonly tenantId: string;
}

@Injectable()
export class ResidentsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(context: ResidentRequestContext): Promise<ListResidentsResponse> {
    const rows = await this.prisma.withTenantContext(
      {
        actor: {
          correlationId: context.correlationId,
          kind: 'user',
          userId: context.actorUserId,
        },
        homeId: context.homeId,
        tenantId: context.tenantId,
      },
      (transaction) =>
        transaction.resident.findMany({
          orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
          take: 200,
        }),
    );
    return { items: rows.map(toResidentResponse) };
  }

  async findById(residentId: string, context: ResidentRequestContext): Promise<ResidentResponse> {
    const resident = await this.prisma.withTenantContext(
      {
        actor: {
          correlationId: context.correlationId,
          kind: 'user',
          userId: context.actorUserId,
        },
        homeId: context.homeId,
        tenantId: context.tenantId,
      },
      (transaction) => transaction.resident.findUnique({ where: { id: residentId } }),
    );
    if (resident === null) {
      throw new NotFoundException(`Resident ${residentId} not found.`);
    }
    return toResidentResponse(resident);
  }
}

function toResidentResponse(row: {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly preferredName: string | null;
  readonly dateOfBirth: Date;
  readonly arrivedAt: Date;
  readonly leftAt: Date | null;
}): ResidentResponse {
  return {
    arrivedAt: row.arrivedAt.toISOString(),
    dateOfBirth: row.dateOfBirth.toISOString(),
    firstName: row.firstName,
    id: row.id,
    lastName: row.lastName,
    leftAt: row.leftAt?.toISOString() ?? null,
    preferredName: row.preferredName,
  };
}
