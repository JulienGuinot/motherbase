const { spawnSync } = require('child_process');
const { Client } = require('pg');

// The original version of this migration used CREATE INDEX CONCURRENTLY, which
// Prisma cannot run inside its migration transaction. Deployments that pulled
// that image keep a failed row in _prisma_migrations and Prisma refuses every
// subsequent startup until it is explicitly marked rolled back.
const RECOVERABLE_FAILED_MIGRATIONS = ['20260720030000_data_retention'];
const PRISMA_ARGS = ['--no-install', 'prisma'];
const SCHEMA_ARGS = ['--schema', 'apps/server/prisma/schema.prisma'];

function runPrisma(args) {
  const result = spawnSync('npx', [...PRISMA_ARGS, ...args, ...SCHEMA_ARGS], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function findRecoverableFailures(
  databaseUrl,
  createClient = connectionString => new Client({ connectionString })
) {
  const client = createClient(databaseUrl);
  await client.connect();
  try {
    const result = await client.query(
      `SELECT migration_name
         FROM "_prisma_migrations"
        WHERE migration_name = ANY($1::text[])
          AND finished_at IS NULL
          AND rolled_back_at IS NULL`,
      [RECOVERABLE_FAILED_MIGRATIONS]
    );
    return result.rows.map(row => row.migration_name);
  } catch (error) {
    // A brand-new database has no Prisma history yet; migrate deploy creates it.
    if (error?.code === '42P01') return [];
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  for (const migration of await findRecoverableFailures(databaseUrl)) {
    console.warn(`[migrations] recovering previously failed migration ${migration}`);
    runPrisma(['migrate', 'resolve', '--rolled-back', migration]);
  }

  runPrisma(['migrate', 'deploy']);
}

if (require.main === module) {
  main().catch(error => {
    console.error('[migrations] failed:', error?.message ?? error);
    process.exit(1);
  });
}

module.exports = { RECOVERABLE_FAILED_MIGRATIONS, findRecoverableFailures };
