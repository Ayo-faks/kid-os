import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface AppliedMigrationRow {
  readonly migration_name: string;
  readonly finished_at: Date | null;
  readonly rolled_back_at: Date | null;
}

@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  private expectedMigrations: readonly string[] | null = null;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('health')
  @ApiOkResponse({ description: 'Liveness probe.' })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({
    description: 'Readiness probe. Fails until every shipped migration is applied.',
  })
  async ready(): Promise<{
    checks: { migrations: 'ok'; postgres: 'ok' };
    migrations: { applied: number; expected: number };
    status: 'ok';
  }> {
    let applied: AppliedMigrationRow[];
    try {
      applied = await this.prisma.$queryRaw<AppliedMigrationRow[]>`
        SELECT migration_name, finished_at, rolled_back_at
        FROM _prisma_migrations
      `;
    } catch (error) {
      throw new ServiceUnavailableException({
        checks: { migrations: 'unknown', postgres: 'failed' },
        error: error instanceof Error ? error.message : 'unknown',
        status: 'error',
      });
    }

    const expected = this.loadExpectedMigrations();
    const appliedNames = new Set(
      applied
        .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
        .map((row) => row.migration_name),
    );
    const missing = expected.filter((name) => !appliedNames.has(name));
    const unfinished = applied.filter(
      (row) => row.finished_at === null && row.rolled_back_at === null,
    );

    if (missing.length > 0 || unfinished.length > 0) {
      throw new ServiceUnavailableException({
        checks: { migrations: 'failed', postgres: 'ok' },
        missing,
        status: 'error',
        unfinished: unfinished.map((row) => row.migration_name),
      });
    }

    return {
      checks: { migrations: 'ok', postgres: 'ok' },
      migrations: { applied: appliedNames.size, expected: expected.length },
      status: 'ok',
    };
  }

  private loadExpectedMigrations(): readonly string[] {
    if (this.expectedMigrations === null) {
      const migrationsDir = resolve(process.cwd(), 'prisma', 'migrations');
      try {
        this.expectedMigrations = readdirSync(migrationsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
      } catch {
        // No local migrations directory (e.g. unit tests) — degrade to
        // requiring only that the migrations table is reachable and settled.
        this.expectedMigrations = [];
      }
    }
    return this.expectedMigrations;
  }
}
