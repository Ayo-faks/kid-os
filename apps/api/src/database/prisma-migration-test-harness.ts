import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Client } from 'pg';

export async function applyAllPrismaMigrations(
  client: Client,
  migrationsRoot: string,
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public._prisma_migrations (
      id varchar(36) PRIMARY KEY,
      checksum varchar(64) NOT NULL,
      finished_at timestamptz,
      migration_name varchar(255) NOT NULL,
      logs text,
      rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(),
      applied_steps_count integer NOT NULL DEFAULT 0
    )
  `);

  const directories = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const directory of directories) {
    await client.query(readFileSync(resolve(migrationsRoot, directory, 'migration.sql'), 'utf8'));
  }
}
