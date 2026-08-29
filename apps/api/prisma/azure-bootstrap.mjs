import pg from 'pg';

const { Client } = pg;

const requiredEnvironment = [
  'MIGRATION_DATABASE_URL',
  'CAREOS_APP_PASSWORD',
  'KEYCLOAK_DATABASE_PASSWORD',
  'TEMPORAL_DATABASE_PASSWORD',
];

for (const name of requiredEnvironment) {
  if ((process.env[name] ?? '') === '') {
    throw new Error(`${name} is required`);
  }
}

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;

async function statement(client, format, values) {
  // format(text, VARIADIC "any") cannot infer parameter types in the extended
  // protocol; every variadic placeholder must carry an explicit ::text cast.
  const result = await client.query(
    `SELECT format($1, ${values.map((_, index) => `$${index + 2}::text`).join(', ')}) AS sql`,
    [format, ...values],
  );
  const sql = result.rows[0]?.sql;
  if (typeof sql !== 'string' || sql === '') throw new Error('failed to build bootstrap SQL');
  await client.query(sql);
}

async function ensureLogin(client, role, password) {
  const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (existing.rowCount === 0) {
    await statement(
      client,
      'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',
      [role, password],
    );
  } else {
    await statement(
      client,
      'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD %L',
      [role, password],
    );
  }
}

async function configureDatabaseOwner(client, database, role) {
  await statement(client, 'ALTER DATABASE %I OWNER TO %I', [database, role]);
  await statement(client, 'GRANT CONNECT ON DATABASE %I TO %I', [database, role]);

  const databaseUrl = new URL(migrationDatabaseUrl);
  databaseUrl.pathname = `/${database}`;
  databaseUrl.searchParams.delete('schema');
  const databaseClient = new Client({ connectionString: databaseUrl.toString() });
  await databaseClient.connect();
  try {
    const schema = await databaseClient.query(
      `SELECT pg_get_userbyid(nspowner) AS owner
         FROM pg_namespace
        WHERE nspname = 'public'`,
    );
    if (schema.rows[0]?.owner !== role) {
      await statement(databaseClient, 'GRANT USAGE, CREATE ON SCHEMA public TO %I', [role]);
      await statement(databaseClient, 'ALTER SCHEMA public OWNER TO %I', [role]);
    }
  } finally {
    await databaseClient.end();
  }
}

const client = new Client({ connectionString: migrationDatabaseUrl });
await client.connect();

try {
  await ensureLogin(client, 'careos_app', process.env.CAREOS_APP_PASSWORD);
  await ensureLogin(client, 'careos_keycloak', process.env.KEYCLOAK_DATABASE_PASSWORD);
  await ensureLogin(client, 'careos_temporal', process.env.TEMPORAL_DATABASE_PASSWORD);
  await statement(client, 'GRANT CONNECT ON DATABASE %I TO %I', ['careos', 'careos_app']);
  await configureDatabaseOwner(client, 'keycloak', 'careos_keycloak');
  await configureDatabaseOwner(client, 'temporal', 'careos_temporal');
  await configureDatabaseOwner(client, 'temporal_visibility', 'careos_temporal');
  process.stdout.write('[database-bootstrap] service roles configured\n');
} finally {
  await client.end();
}
