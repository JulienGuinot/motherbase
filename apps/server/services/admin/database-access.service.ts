import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { Prisma } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { env } from '../../config/env';
import { HttpException } from '../../exceptions/http-exception';
import {
  DEFAULT_DATABASE_ACCESS,
  networkRestrictionsSchema,
  renderPgHba,
  sslEnforcementSchema,
  type DatabaseAccessConfig,
} from './database-access';

const SETTING_KEY = 'database.access';
const CERT_FILE = 'server.crt';
const KEY_FILE = 'server.key';
const run = promisify(execFile);

function zodMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues.map(issue => issue.message).join('; ');
}

/**
 * Network restrictions and SSL enforcement for direct Postgres connections.
 *
 * Everything goes through SQL on the project's own connection (the API is the
 * database superuser in its stack): the rules are rendered into pg_hba.conf,
 * the certificate into the data directory, and Postgres reloads them without
 * a restart. Nothing on the host or in the compose file changes.
 *
 * Applying only happens inside a Console-managed stack
 * (DATABASE_ACCESS_MANAGED=true in deploy/docker-compose.prod.yml). Anywhere
 * else the database may be shared with other things (a dev machine, CI, a
 * managed Postgres), and rewriting its pg_hba.conf would be an outage for all
 * of them; there the settings are stored and reported as not applied.
 */
export class DatabaseAccessService extends BaseContext {
  managed(): boolean {
    return /^(1|true|yes)$/i.test(process.env.DATABASE_ACCESS_MANAGED?.trim() ?? '');
  }

  async config(): Promise<DatabaseAccessConfig> {
    const row = await this.di.prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    return { ...DEFAULT_DATABASE_ACCESS, ...((row?.value ?? {}) as Partial<DatabaseAccessConfig>) };
  }

  async networkRestrictions() {
    const config = await this.config();
    return {
      dbAllowedCidrs: config.dbAllowedCidrs,
      dbAllowedCidrsV6: config.dbAllowedCidrsV6,
      // Supabase's "applied" vs "stored": whether the rules are live.
      status: this.managed() ? 'applied' : 'stored',
      // Restrictions only matter once the port is reachable from outside.
      exposure: this.exposure(),
    };
  }

  async updateNetworkRestrictions(input: unknown) {
    const parsed = networkRestrictionsSchema.safeParse(input ?? {});
    if (!parsed.success) throw new HttpException(zodMessage(parsed.error), 400);
    await this.save({ ...(await this.config()), ...parsed.data });
    return this.networkRestrictions();
  }

  async sslEnforcement() {
    const config = await this.config();
    return {
      enforced: config.sslEnforced,
      status: this.managed() ? 'applied' : 'stored',
      // What Postgres is actually doing, not what was asked for.
      sslActive: (await this.setting('ssl').catch(() => 'off')) === 'on',
      exposure: this.exposure(),
    };
  }

  async updateSslEnforcement(input: unknown) {
    const parsed = sslEnforcementSchema.safeParse(input ?? {});
    if (!parsed.success) throw new HttpException(zodMessage(parsed.error), 400);
    await this.save({ ...(await this.config()), sslEnforced: parsed.data.enforced });
    return this.sslEnforcement();
  }

  private exposure(): 'loopback' | 'public' | 'unpublished' {
    const port = Number(process.env.DB_PORT);
    if (!Number.isInteger(port) || port <= 0) return 'unpublished';
    const bind = (process.env.DB_BIND || '127.0.0.1').trim();
    return ['127.0.0.1', 'localhost', '::1'].includes(bind) ? 'loopback' : 'public';
  }

  /** Apply first, persist second: a rule Postgres refused is never recorded as the setting. */
  private async save(next: DatabaseAccessConfig): Promise<void> {
    if (this.managed()) {
      if (next.sslEnforced) await this.ensureTls();
      await this.writeHba(renderPgHba(next));
    }
    const value = next as unknown as Prisma.InputJsonValue;
    await this.di.prisma.appSetting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value },
      update: { value },
    });
  }

  private async setting(name: string): Promise<string> {
    const rows = await this.di.prisma.$queryRaw<Array<{ value: string }>>`SELECT current_setting(${name}) AS value`;
    return rows[0]?.value ?? '';
  }

  /**
   * Replace pg_hba.conf, but only with a file Postgres parses cleanly.
   *
   * `pg_hba_file_rules` reads the file on disk, not the loaded one, so it
   * validates the new rules before the reload makes them live. A bad file is
   * put back as it was: Postgres keeps the old rules on a failed reload, but a
   * later restart would load the broken file and refuse every connection.
   */
  private async writeHba(content: string): Promise<void> {
    const file = await this.setting('hba_file');
    const [{ previous }] = await this.di.prisma.$queryRaw<Array<{ previous: string }>>`SELECT pg_read_file(${file}) AS previous`;
    await this.writeServerFile(file, content);
    const errors = await this.di.prisma.$queryRaw<Array<{ line_number: number; error: string }>>`
      SELECT line_number, error FROM pg_hba_file_rules WHERE error IS NOT NULL`;
    if (errors.length) {
      await this.writeServerFile(file, previous);
      throw new HttpException(`Postgres rejected the rules: ${errors.map(e => `line ${e.line_number}: ${e.error}`).join('; ')}`, 400);
    }
    await this.di.prisma.$queryRaw`SELECT pg_reload_conf()`;
  }

  /**
   * Overwrite a file the database server owns, through a large object.
   *
   * `lo_export` keeps the mode of a file that already exists, which is what
   * pg_hba.conf needs. It creates new files world-readable, which is fine for
   * the certificate and wrong for its key: see writePrivateFile.
   */
  private async writeServerFile(file: string, content: string): Promise<void> {
    await this.di.prisma.$transaction(async tx => {
      const [{ oid }] = await tx.$queryRaw<Array<{ oid: number }>>`SELECT lo_from_bytea(0, ${Buffer.from(content)}) AS oid`;
      await tx.$queryRaw`SELECT lo_export(${oid}::oid, ${file})`;
      await tx.$queryRaw`SELECT lo_unlink(${oid}::oid)`;
    });
  }

  /**
   * Postgres refuses a private key readable by anyone but itself, and every
   * other way SQL can create a file relaxes the mode. adminpack's
   * pg_file_write keeps the server's owner-only umask, so the key is written
   * with it (paths are relative to the data directory). adminpack ships with
   * Postgres 16, which is what the project image runs; it was removed in 17.
   */
  private async writePrivateFile(name: string, content: string): Promise<void> {
    await this.di.prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS adminpack');
    await this.di.prisma.$queryRaw`SELECT pg_file_unlink(${name})`;
    await this.di.prisma.$queryRaw`SELECT pg_file_write(${name}, ${content}, false)`;
  }

  /**
   * Turn TLS on with a self-signed certificate, once. Clients connect with
   * `sslmode=require`; verifying the certificate itself needs a real CA, which
   * a self-hosted stack does not have.
   *
   * A key Postgres cannot load leaves `ssl` off after the reload. The setting
   * is then reset, because the next restart would otherwise try to start with
   * ssl=on and a broken key, and fail to start at all.
   */
  private async ensureTls(): Promise<void> {
    if ((await this.setting('ssl')) === 'on') return;
    const { cert, key } = await this.selfSignedCertificate();
    const dataDir = await this.setting('data_directory');
    await this.writeServerFile(path.posix.join(dataDir, CERT_FILE), cert);
    await this.writePrivateFile(KEY_FILE, key);
    await this.di.prisma.$executeRawUnsafe(`ALTER SYSTEM SET ssl_cert_file = '${CERT_FILE}'`);
    await this.di.prisma.$executeRawUnsafe(`ALTER SYSTEM SET ssl_key_file = '${KEY_FILE}'`);
    await this.di.prisma.$executeRawUnsafe('ALTER SYSTEM SET ssl = on');
    await this.di.prisma.$queryRaw`SELECT pg_reload_conf()`;
    if (await this.sslCameUp()) return;
    await this.di.prisma.$executeRawUnsafe('ALTER SYSTEM RESET ssl');
    await this.di.prisma.$queryRaw`SELECT pg_reload_conf()`;
    throw new HttpException('Postgres did not accept the generated certificate; TLS stays off. See the database logs.', 500, undefined, { expose: true });
  }

  /** The reload is asynchronous: give the postmaster a moment to pick it up. */
  private async sslCameUp(): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await this.setting('ssl')) === 'on') return true;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
  }

  private async selfSignedCertificate(): Promise<{ cert: string; key: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mb-db-tls-'));
    try {
      const keyFile = path.join(dir, KEY_FILE);
      const certFile = path.join(dir, CERT_FILE);
      await run('openssl', [
        'req', '-x509', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-days', '3650', '-subj', `/CN=${env.BASE_HOST || 'motherbase-db'}`,
        '-keyout', keyFile, '-out', certFile,
      ]);
      return { cert: await fs.readFile(certFile, 'utf8'), key: await fs.readFile(keyFile, 'utf8') };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
