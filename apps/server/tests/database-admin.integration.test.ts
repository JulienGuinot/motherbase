import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import prisma from '../lib/prisma';
import { SchemaService } from '../services/admin/schema.service';
import { EnumTypeService } from '../services/admin/enum-type.service';
import { DatabaseRoleService } from '../services/admin/database-role.service';
import { PublicationService } from '../services/admin/publication.service';
import { PostgresConfigService } from '../services/admin/postgres-config.service';

// The Database section's services against a real Postgres. Roles are
// cluster-wide, so every name carries a random suffix: parallel suites on the
// same server must not trip over each other's roles.

const suffix = randomBytes(3).toString('hex');
const TABLE = `db_admin_notes_${suffix}`;
const ENUM = `db_admin_mood_${suffix}`;
const ROLE = `db_admin_reader_${suffix}`;
const PUBLICATION = `db_admin_pub_${suffix}`;

const schema = new SchemaService({});
const enums = new EnumTypeService({});
const roles = new DatabaseRoleService({});
const publications = new PublicationService({});
const config = new PostgresConfigService({});

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`CREATE TABLE "${TABLE}" (id serial PRIMARY KEY, body text, secret text)`);
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP PUBLICATION IF EXISTS "${PUBLICATION}"`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
  await prisma.$executeRawUnsafe(`DROP TYPE IF EXISTS "${ENUM}"`);
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}"`);
  await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${ROLE}_renamed"`);
  await prisma.$executeRawUnsafe(`ALTER DATABASE "${(await config.get()).database}" RESET lock_timeout`);
});

describe('tables and indexes', () => {
  it('lists table stats and every index of a schema with its method and columns', async () => {
    await schema.createIndex(TABLE, ['body'], false, 'btree', 'public', `${TABLE}_body_idx`);

    const stats = (await schema.listTableStats('public')).find(table => table.name === TABLE);
    expect(stats).toMatchObject({ kind: 'table', columns: 3, rlsEnabled: false });
    expect(stats!.totalBytes).toBeGreaterThan(0);

    const indexes = (await schema.listSchemaIndexes('public')).filter(index => index.table === TABLE);
    expect(indexes.find(index => index.primary)).toMatchObject({ method: 'btree', columns: ['id'], unique: true });
    expect(indexes.find(index => index.name === `${TABLE}_body_idx`)).toMatchObject({ columns: ['body'], unique: false });
  });

  it('refuses an unknown access method before building SQL', async () => {
    await expect(schema.createIndex(TABLE, ['body'], false, 'btree) ; drop table x; --' as never, 'public'))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('enumerated types', () => {
  it('creates, extends, renames a value, and reports the columns using it', async () => {
    await enums.create(ENUM, ['happy', 'sad'], 'public');
    await enums.addValue(ENUM, 'meh', { after: 'happy' }, 'public');
    await enums.renameValue(ENUM, 'sad', 'grumpy', 'public');
    await prisma.$executeRawUnsafe(`ALTER TABLE "${TABLE}" ADD COLUMN mood "${ENUM}"`);

    const type = (await enums.list('public')).find(entry => entry.name === ENUM);
    expect(type).toMatchObject({ values: ['happy', 'meh', 'grumpy'], usedBy: [`${TABLE}.mood`] });
  });

  it('refuses to drop a type a column still uses', async () => {
    await expect(enums.drop(ENUM, 'public')).rejects.toMatchObject({ statusCode: 400 });
    await prisma.$executeRawUnsafe(`ALTER TABLE "${TABLE}" DROP COLUMN mood`);
    await enums.drop(ENUM, 'public');
    expect((await enums.list('public')).some(entry => entry.name === ENUM)).toBe(false);
  });
});

describe('roles and column privileges', () => {
  it('creates and alters a role, and lists its attributes', async () => {
    await roles.create({ name: ROLE, canLogin: false, connectionLimit: 3 });
    await roles.update(ROLE, { canLogin: true, password: 'not-a-real-secret' });

    const role = (await roles.list()).find(entry => entry.name === ROLE);
    expect(role).toMatchObject({ canLogin: true, connectionLimit: 3, isSuperuser: false, reserved: null });
  });

  it('refuses every write to a reserved role', async () => {
    await expect(roles.drop('anon')).rejects.toMatchObject({ statusCode: 403 });
    await expect(roles.update('postgres', { canLogin: false })).rejects.toMatchObject({ statusCode: 403 });
    await expect(roles.create({ name: 'service_role' })).rejects.toMatchObject({ statusCode: 400 });
    expect((await roles.list()).find(entry => entry.name === 'authenticated')?.reserved).toBeTruthy();
  });

  it('revokes one column out of a table-level grant', async () => {
    await prisma.$executeRawUnsafe(`GRANT SELECT ON "${TABLE}" TO "${ROLE}"`);
    const before = await roles.columnPrivileges(TABLE, 'public');
    expect(before.roles.find(entry => entry.role === ROLE)?.privileges.SELECT).toMatchObject({ tableLevel: true });

    const after = await roles.setColumnPrivilege({
      table: TABLE, schema: 'public', role: ROLE, privilege: 'SELECT', columns: ['secret'], grant: false,
    });
    expect(after.roles.find(entry => entry.role === ROLE)?.privileges.SELECT).toEqual({ tableLevel: false, columns: ['id', 'body'] });

    const [{ can }] = await prisma.$queryRawUnsafe<Array<{ can: boolean }>>(
      `SELECT has_column_privilege($1, $2, 'secret', 'SELECT') AS can`, ROLE, TABLE,
    );
    expect(can).toBe(false);
  });

  it('renames and drops a role once its grants are gone', async () => {
    await prisma.$executeRawUnsafe(`REVOKE ALL ON "${TABLE}" FROM "${ROLE}"`);
    await roles.update(ROLE, { name: `${ROLE}_renamed` });
    await roles.drop(`${ROLE}_renamed`);
    expect((await roles.list()).some(entry => entry.name.startsWith(ROLE))).toBe(false);
  });
});

describe('publications', () => {
  it('creates, toggles a table and the published actions, then drops', async () => {
    await publications.create({ name: PUBLICATION, insert: true, update: true, delete: false, truncate: false });
    await publications.update(PUBLICATION, { delete: true, addTables: [{ schema: 'public', table: TABLE }] });

    const overview = await publications.list();
    expect(overview.walLevel).toBeTruthy();
    expect(overview.publications.find(entry => entry.name === PUBLICATION)).toMatchObject({
      insert: true, update: true, delete: true, truncate: false, supabaseRealtime: false,
      tables: [{ schema: 'public', table: TABLE }],
    });

    await publications.update(PUBLICATION, { dropTables: [{ schema: 'public', table: TABLE }] });
    await publications.drop(PUBLICATION);
    expect((await publications.list()).publications.some(entry => entry.name === PUBLICATION)).toBe(false);
  });
});

describe('postgres config', () => {
  it('reads the curated settings with the scopes each allows', async () => {
    const current = await config.get();
    expect(current.settings.find(setting => setting.name === 'work_mem')?.scopes).toEqual(['database', 'role', 'system']);
    expect(current.settings.find(setting => setting.name === 'max_connections')?.scopes).toEqual(['system']);
  });

  it('pins a session setting on the database and resets it', async () => {
    const result = await config.update([{ name: 'lock_timeout', value: '7s' }]);
    expect(result).toEqual({ applied: [{ name: 'lock_timeout', scope: 'database' }], restartRequired: [] });
    const pinned = (await config.get()).settings.find(setting => setting.name === 'lock_timeout');
    expect(pinned?.overrides).toContainEqual({ scope: 'database', value: '7s' });

    await config.update([{ name: 'lock_timeout', value: null }]);
    const reset = (await config.get()).settings.find(setting => setting.name === 'lock_timeout');
    expect(reset?.overrides.some(override => override.scope === 'database')).toBe(false);
  });

  it('refuses settings outside the curated list and scopes Postgres would reject', async () => {
    await expect(config.update([{ name: 'fsync', value: 'off' }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(config.update([{ name: 'shared_buffers', value: '1GB', scope: 'database' }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(config.update([{ name: 'work_mem', value: 'lots' }])).rejects.toMatchObject({ statusCode: 400 });
  });
});
