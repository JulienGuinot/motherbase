import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prisma from '../lib/prisma';
import { VaultService } from '../services/admin/vault.service';
import { credentialSecretName, WrapperService } from '../services/admin/wrapper.service';

/**
 * Wrappers against the real database. postgres_fdw is pointed back at this same
 * database over loopback, which is a real remote connection as far as the
 * wrapper knows: it authenticates, plans remotely and returns remote rows.
 */

const vault = new VaultService({ prisma } as never);
const wrappers = new WrapperService({ prisma, VaultService: vault } as never);

const SERVER = 'it_fdw_loopback';
const FILE_SERVER = 'it_fdw_files';
const REMOTE = 'it_fdw_remote';
const LOCAL = 'it_fdw_local';
let previousRoot: string | undefined;

beforeAll(async () => {
  previousRoot = process.env.CONFIG_ENCRYPTION_KEY;
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  for (const server of [SERVER, FILE_SERVER]) {
    await prisma.$executeRawUnsafe(`DROP SERVER IF EXISTS ${server} CASCADE`);
  }
  await prisma.$executeRawUnsafe(`DELETE FROM vault.secrets WHERE name LIKE 'fdw_it_fdw_%'`).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${REMOTE} CASCADE`);
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${LOCAL} CASCADE`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA ${REMOTE}`);
  await prisma.$executeRawUnsafe(`CREATE TABLE ${REMOTE}.orders (id int PRIMARY KEY, total numeric)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE ${REMOTE}.ignored (id int)`);
  await prisma.$executeRawUnsafe(`INSERT INTO ${REMOTE}.orders VALUES (1, 9.5), (2, 20)`);
});

afterAll(async () => {
  for (const server of [SERVER, FILE_SERVER]) await wrappers.dropServer(server).catch(() => undefined);
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${REMOTE} CASCADE`);
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${LOCAL} CASCADE`);
  process.env.CONFIG_ENCRYPTION_KEY = previousRoot;
});

describe('postgres_fdw', () => {
  it('creates a server, keeps the password in the Vault, and never lists it', async () => {
    const server = await wrappers.createServer({
      name: SERVER,
      wrapper: 'postgres_fdw',
      options: { host: 'localhost', port: await listeningPort(), dbname: await currentDatabase() },
      user: 'postgres',
      password: 'postgres',
    });
    expect(server).toMatchObject({ wrapper: 'postgres_fdw', hasUserMapping: true, remoteUser: 'postgres' });
    expect(server.vaultSecretId).toBeTruthy();
    expect(await vault.reveal(server.vaultSecretId!)).toBe('postgres');
    expect(JSON.stringify(await wrappers.list())).not.toContain('password');
  });

  it('imports only the tables asked for, and they return remote rows', async () => {
    const tables = await wrappers.importSchema(SERVER, { remoteSchema: REMOTE, localSchema: LOCAL, tables: ['orders'] });
    expect(tables.map(t => t.name)).toEqual(['orders']);
    const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM ${LOCAL}.orders ORDER BY id`);
    expect(rows.map(r => r.id)).toEqual([1, 2]);
  });

  it('rotates the credential in the mapping and the Vault together', async () => {
    const server = await wrappers.setCredentials(SERVER, { user: 'postgres', password: 'wrong-now' });
    expect(await vault.reveal(server.vaultSecretId!)).toBe('wrong-now');
    // Read from the catalog rather than by failing a query: loopback may be
    // trust-authenticated, and postgres_fdw caches its connection per session.
    const [mapping] = await prisma.$queryRawUnsafe<Array<{ umoptions: string[] }>>(
      `SELECT umoptions FROM pg_user_mappings WHERE srvname = $1 AND usename = current_user`,
      SERVER,
    );
    expect(mapping.umoptions).toContain('password=wrong-now');
    await wrappers.setCredentials(SERVER, { user: 'postgres', password: 'postgres' });
  });

  it('refuses credentials passed as server options', async () => {
    await expect(
      wrappers.createServer({ name: 'it_fdw_bad', wrapper: 'postgres_fdw', options: { password: 'x' } }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('drops the server with its tables and its Vault secret', async () => {
    const secretId = (await wrappers.list()).servers.find(s => s.name === SERVER)!.vaultSecretId;
    await wrappers.dropServer(SERVER);
    const after = await wrappers.list();
    expect(after.servers.some(s => s.name === SERVER)).toBe(false);
    expect(after.tables.some(t => t.server === SERVER)).toBe(false);
    expect(await vault.findByName(credentialSecretName(SERVER))).toBeUndefined();
    expect(secretId).toBeTruthy();
  });
});

describe('file_fdw', () => {
  it('reads a file on the database server as a table', async () => {
    await wrappers.createServer({ name: FILE_SERVER, wrapper: 'file_fdw', options: {} });
    const table = await wrappers.createForeignTable({
      server: FILE_SERVER,
      schema: LOCAL,
      name: 'os_release',
      columns: [{ name: 'line', type: 'text' }],
      options: { filename: '/etc/os-release', format: 'text' },
    });
    expect(table).toMatchObject({ server: FILE_SERVER, columns: 1, options: { filename: '/etc/os-release' } });
    const rows = await prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM ${LOCAL}.os_release`);
    expect(rows.length).toBeGreaterThan(0);

    await wrappers.dropForeignTable(LOCAL, 'os_release');
    expect((await wrappers.list()).tables.some(t => t.name === 'os_release')).toBe(false);
  });
});

async function currentDatabase(): Promise<string> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ db: string }>>('SELECT current_database() AS db');
  return row.db;
}

// postgres_fdw connects from inside the server, so the port is the one Postgres
// itself listens on (5432 in the container), not the host-mapped one in DATABASE_URL.
async function listeningPort(): Promise<string> {
  const [row] = await prisma.$queryRawUnsafe<Array<{ port: string }>>("SELECT current_setting('port') AS port");
  return row.port;
}
