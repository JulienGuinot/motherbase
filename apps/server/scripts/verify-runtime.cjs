// Runs exclusively inside deploy/verify-runtime.sh's disposable Compose stack.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { Client } = require('pg');
const { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { env } = require('../dist/config/env');
const { BackupService } = require('../dist/services/admin/backup.service');

async function main() {
  assert.match(process.env.RUNTIME_VERIFY_PROJECT || '', /^motherbase-verify-\d+-\d+$/,
    'Only run in the disposable runtime verification stack');
  const sourceUrl = new URL(env.DATABASE_URL);
  assert.equal(sourceUrl.hostname, 'db');
  assert.equal(sourceUrl.pathname, '/app');

  const health = await fetch('http://127.0.0.1:5001/api/health-check', { signal: AbortSignal.timeout(15000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).db, 'connected');

  const source = new Client({ connectionString: env.DATABASE_URL });
  const restoreUrl = new URL(sourceUrl);
  restoreUrl.pathname = '/motherbase_restore_verify';
  const restored = new Client({ connectionString: restoreUrl.toString() });
  const backups = new BackupService({});
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT, region: env.S3_REGION, forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  await source.connect();
  try {
    // Exercise the actual migrated schema plus an application table and RLS.
    await source.query(`CREATE TABLE public.restore_probe (id text PRIMARY KEY, owner_id text NOT NULL);
      INSERT INTO public.restore_probe VALUES ('sentinel', 'owner');
      ALTER TABLE public.restore_probe ENABLE ROW LEVEL SECURITY;
      CREATE POLICY owner_only ON public.restore_probe USING (owner_id = current_user);`);
    const expected = await source.query(`SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname IN ('public', 'auth', 'storage', 'platform') ORDER BY 1, 2`);
    const dump = await backups.backupDatabase('runtime-verify.sql');
    assert.ok(dump.file.size > 0);
    // An S3 upload/download is part of the restore path, rather than merely
    // asserting that the local dump file exists. This bucket is private.
    await s3.send(new CreateBucketCommand({ Bucket: 'restore-drill' }));
    const bytes = await fs.readFile(dump.file.path);
    await s3.send(new PutObjectCommand({ Bucket: 'restore-drill', Key: dump.file.name, Body: bytes }));
    const anonymous = await fetch(`${env.S3_ENDPOINT}/restore-drill/${dump.file.name}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(anonymous.status, 403, 'Backup objects must not be downloadable anonymously');
    const download = await s3.send(new GetObjectCommand({ Bucket: 'restore-drill', Key: dump.file.name }));
    const downloaded = Buffer.from(await download.Body.transformToByteArray());
    assert.deepEqual(downloaded, bytes);
    await fs.writeFile(dump.file.path, downloaded);

    // CREATE, never DROP: fail if the supposedly fresh target already exists.
    await source.query('CREATE DATABASE motherbase_restore_verify TEMPLATE template0');
    env.DATABASE_URL = restoreUrl.toString();
    await backups.restoreDatabase({ file: dump.file.name, confirm: 'RESTORE' });
    await restored.connect();
    const actual = await restored.query(`SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname IN ('public', 'auth', 'storage', 'platform') ORDER BY 1, 2`);
    assert.deepEqual(actual.rows, expected.rows, 'All application schemas must be restored');
    assert.deepEqual((await restored.query('SELECT * FROM public.restore_probe')).rows,
      [{ id: 'sentinel', owner_id: 'owner' }]);
    assert.equal((await restored.query(`SELECT count(*)::int AS count FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'restore_probe' AND policyname = 'owner_only'`)).rows[0].count, 1);
    assert.equal((await restored.query(`SELECT count(*)::int AS count FROM public._prisma_migrations
      WHERE finished_at IS NOT NULL`)).rows[0].count,
    (await source.query(`SELECT count(*)::int AS count FROM public._prisma_migrations
      WHERE finished_at IS NOT NULL`)).rows[0].count);
  } finally {
    env.DATABASE_URL = sourceUrl.toString();
    s3.destroy();
    await Promise.allSettled([source.end(), restored.end()]);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
