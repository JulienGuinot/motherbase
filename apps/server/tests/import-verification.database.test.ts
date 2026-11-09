import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureImportManifest, verifyImportManifest } from '../services/admin/import-verification';

const enabled = process.env.RUN_IMPORT_VERIFICATION_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('import verification against isolated PostgreSQL schemas', () => {
  const suffix = randomUUID().replace(/-/g, '');
  const sourceSchema = `mb_import_verify_source_${suffix}`;
  const targetSchema = `mb_import_verify_target_${suffix}`;
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await createFixtureSchema(client, sourceSchema);
    await createFixtureSchema(client, targetSchema);
  });

  afterAll(async () => {
    if (!client) return;
    for (const schema of [sourceSchema, targetSchema]) {
      if (!/^mb_import_verify_(source|target)_[a-f0-9]{32}$/.test(schema)) {
        throw new Error(`Refusing to clean unexpected schema: ${schema}`);
      }
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await client.end();
  });

  it('compares tables, rows, constraints, RLS and policies on a disposable copy', async () => {
    const options = { includeRows: true, includeSchemaObjects: true };
    const source = await captureImportManifest(client, { ...options, schema: sourceSchema });
    const restored = await captureImportManifest(client, { ...options, schema: targetSchema });

    expect(verifyImportManifest(source, restored).valid).toBe(true);

    await client.query(`ALTER TABLE "${targetSchema}".todos DISABLE ROW LEVEL SECURITY`);
    await client.query(`DROP POLICY read_todos ON "${targetSchema}".todos`);
    const damaged = await captureImportManifest(client, { ...options, schema: targetSchema });

    expect(verifyImportManifest(source, damaged)).toMatchObject({ valid: false });
  });
});

async function createFixtureSchema(client: Client, schema: string): Promise<void> {
  if (!/^mb_import_verify_(source|target)_[a-f0-9]{32}$/.test(schema)) {
    throw new Error(`Refusing to create unexpected schema: ${schema}`);
  }
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(
    `CREATE TABLE "${schema}".todos (
       id integer PRIMARY KEY,
       slug text NOT NULL UNIQUE,
       done boolean NOT NULL DEFAULT false,
       CONSTRAINT slug_not_empty CHECK (length(slug) > 0)
     )`
  );
  await client.query(`ALTER TABLE "${schema}".todos ENABLE ROW LEVEL SECURITY`);
  await client.query(`CREATE POLICY read_todos ON "${schema}".todos FOR SELECT USING (true)`);
  await client.query(`INSERT INTO "${schema}".todos (id, slug) VALUES (1, 'first'), (2, 'second')`);
}
