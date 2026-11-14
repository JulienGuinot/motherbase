import { createReadStream, createWriteStream } from 'fs';
import fs from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import path from 'path';
import { FileStatus } from '@prisma/client';
import BaseContext from '../../context/base-context';
import { env } from '../../config/env';
import { logActivity } from '../../lib/activity-log';
import { HttpException } from '../../exceptions/http-exception';
import { BackupRemote, RemoteBackup } from './backup-remote';
import { runCommand, toLibpqUrl, type CommandResult } from './pg-command';
import { neutralizeUnsupportedSettings, PORTABLE_DUMP_SETTINGS } from './dump-compat';
import { invalidateSigningKeys, revokeAccessTokens } from '../../auth/access-tokens';
import { readTar, tarStream, type TarStreamEntry } from './tar-writer';

/**
 * What a file in the backup directory actually is, and what can be done to it.
 *
 * Three different things land in this directory: a plain SQL dump, a `.tar`
 * bundling that dump with every storage object, and a `.json` schema export.
 * Restore shells out to `psql --file`, so only a dump can be restored. The kind
 * travels with the row, and the console only offers what the kind supports.
 */
export type BackupKind = 'database' | 'full' | 'export' | 'unknown';

export interface BackupFile {
  name: string;
  path: string;
  size: number;
  createdAt: string;
  kind: BackupKind;
  /** True only when `restoreDatabase` can actually read this file. */
  restorable: boolean;
  /** Set when the file must be unpacked before any part of it is restorable. */
  extractable: boolean;
}

/** Classify by extension: it is what the writers here choose, and all psql sees. */
export function classifyBackup(name: string): Pick<BackupFile, 'kind' | 'restorable' | 'extractable'> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.sql')) return { kind: 'database', restorable: true, extractable: false };
  if (lower.endsWith('.tar')) return { kind: 'full', restorable: false, extractable: true };
  if (lower.endsWith('.json')) return { kind: 'export', restorable: false, extractable: false };
  return { kind: 'unknown', restorable: false, extractable: false };
}

export interface BackupScheduleConfig {
  enabled: boolean;
  cron: string;
  retention: number;
  offsite: boolean;
}

export interface BackupResult {
  file: BackupFile;
  stdout: string;
  stderr: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export class BackupService extends BaseContext {
  // S3 wrapper for offsite backups. Overridable in tests (inject a fake client).
  protected remote = new BackupRemote();

  private root(): string {
    return path.resolve(process.cwd(), env.BACKUP_DIR);
  }

  /** Effective backup schedule config (AppSetting overrides env). */
  async config(): Promise<BackupScheduleConfig> {
    return this.di.SettingsService.get<BackupScheduleConfig>('backup.schedule');
  }

  /** True only when offsite is enabled AND an S3 driver is configured. */
  private async offsiteEnabled(): Promise<boolean> {
    if (env.STORAGE_DRIVER !== 's3') return false;
    const cfg = await this.config();
    return !!cfg.offsite;
  }

  /**
   * Keep the newest `retention` local *database dumps*; delete the rest.
   *
   * Only `kind === 'database'`. The retention window belongs to the scheduled
   * `.sql` job. Full-project `.tar` and `.json` exports are never pruned: they
   * are the one kind of file in here nothing else reproduces.
   */
  async pruneLocal(retention: number): Promise<string[]> {
    const keep = Math.max(0, Math.floor(retention));
    const files = (await this.list()).filter(f => f.kind === 'database'); // already newest-first
    const stale = files.slice(keep);
    for (const f of stale) {
      await fs.unlink(this.resolveInsideRoot(f.name));
    }
    return stale.map(f => f.name);
  }

  /** Upload a local dump offsite. Skipped (warn, no throw) when offsite is off. */
  async uploadBackup(localPath: string, key: string): Promise<{ skipped: boolean; key?: string }> {
    if (!(await this.offsiteEnabled())) {
      logActivity('warn', 'job', '[backup] offsite disabled or STORAGE_DRIVER=local. Skipping upload');
      return { skipped: true };
    }
    await this.remote.upload(localPath, key);
    return { skipped: false, key };
  }

  /** List offsite backups. Returns [] (no throw) when offsite is off. */
  async listRemote(): Promise<Array<RemoteBackup & Pick<BackupFile, 'kind' | 'restorable' | 'extractable'>>> {
    if (!(await this.offsiteEnabled())) return [];
    // Offsite rows get the same contract: the console draws one list and must
    // not offer Restore on an object it cannot restore just because it is remote.
    return (await this.remote.list()).map(object => ({ ...object, ...classifyBackup(object.key) }));
  }

  /** Prune offsite backups to `retention`. Skipped (warn, no throw) when off. */
  async pruneRemote(retention: number): Promise<string[]> {
    if (!(await this.offsiteEnabled())) {
      logActivity('warn', 'job', '[backup] offsite disabled or STORAGE_DRIVER=local. Skipping remote prune');
      return [];
    }
    return this.remote.prune(retention);
  }

  /** Download a remote backup into a path validated by resolveInsideRoot. */
  async downloadBackup(key: string, localName = path.basename(key)): Promise<BackupFile> {
    const dest = this.resolveInsideRoot(localName);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await this.remote.download(key, dest);
    return this.describe(dest);
  }

  /** Combined local + (offsite when enabled) backup listing. */
  async listAll(): Promise<{ local: BackupFile[]; remote: RemoteBackup[] }> {
    const [local, remote] = await Promise.all([this.list(), this.listRemote()]);
    return { local, remote };
  }

  /**
   * Restore from an offsite backup: download it locally, then restore.
   * Never auto-restores: always requires confirm === 'RESTORE'.
   */
  async restoreFromRemote(input: { key: string; confirm?: string }): Promise<CommandResult> {
    if (input.confirm !== 'RESTORE') throw new HttpException('Restore requires confirm=RESTORE', 400);
    if (!input.key?.trim()) throw new HttpException('key is required', 400);
    if (!classifyBackup(input.key).restorable) {
      throw new HttpException(`${input.key} is not a restorable database dump. Download it instead.`, 400);
    }
    const local = await this.downloadBackup(input.key);
    return this.restoreDatabase({ file: local.name, confirm: 'RESTORE' });
  }

  async list(): Promise<BackupFile[]> {
    await fs.mkdir(this.root(), { recursive: true });
    const entries = await fs.readdir(this.root(), { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter(entry => entry.isFile())
        .map(async entry => this.describe(path.join(this.root(), entry.name)))
    );
    return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * `clean` prefixes every object with a DROP ... IF EXISTS, so the dump can be
   * restored over a database that already has the same schema (a branch stack,
   * which has run its own migrations before the copy arrives). Off by default:
   * restoring a clean dump over the wrong database replaces it wholesale.
   */
  async backupDatabase(
    outputName = `motherbase-db-${timestamp()}.sql`,
    options: { clean?: boolean } = {},
  ): Promise<BackupResult> {
    const file = this.resolveInsideRoot(outputName);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const result = await this.run('pg_dump', [
      '--dbname',
      toLibpqUrl(env.DATABASE_URL),
      '--format=plain',
      // --no-owner stays: object ownership is whatever role the restore runs
      // as. --no-privileges does NOT: it stripped every GRANT, including the
      // ones the data API depends on (anon/authenticated on public), so a
      // restored project answered every request with a permission error.
      '--no-owner',
      ...(options.clean ? ['--clean', '--if-exists'] : []),
      '--file',
      file,
    ]);
    return { file: await this.describe(file), ...result };
  }

  async restoreDatabase(input: { file: string; confirm?: string }): Promise<CommandResult> {
    if (input.confirm !== 'RESTORE') throw new HttpException('Restore requires confirm=RESTORE', 400);
    // Second line of defence behind the console only offering Restore on a
    // restorable row: this endpoint is reachable directly, and handing psql a
    // tar or a JSON export fails halfway through with a parse error on binary
    // input, which reads to an operator like a corrupt backup.
    const { kind, restorable, extractable } = classifyBackup(input.file);
    if (!restorable) {
      throw new HttpException(
        extractable
          ? `${input.file} is a full project archive. Extract it first (POST /backups/extract), then restore the database.sql it contains.`
          : `${input.file} is a ${kind} file, which the database restore cannot read. Only .sql dumps are restorable.`,
        400
      );
    }
    const file = this.resolveInsideRoot(input.file);
    await this.assertReadable(file);
    await this.makeDumpPortable(file);
    try {
      return await this.run('psql', ['--dbname', toLibpqUrl(env.DATABASE_URL), '--set', 'ON_ERROR_STOP=1', '--file', file]);
    } finally {
      // Users, sessions and signing keys may all be other rows now, and a
      // restore that failed halfway replaced some of them: nothing this process
      // remembers about access tokens describes the database any more.
      invalidateSigningKeys();
      revokeAccessTokens();
    }
  }

  /**
   * Comment out preamble `SET` directives the target Postgres will not know.
   *
   * The runtime image ships pg_dump 17 (it has to: a Supabase source runs 17)
   * while a project database runs Postgres 16, and pg_dump writes its own
   * version's preamble whatever server it dumped. `SET transaction_timeout`
   * therefore sits on line 13 of every dump this project takes of itself, and
   * psql --set ON_ERROR_STOP=1 aborts the whole restore on it:
   *
   *   ERROR: unrecognized configuration parameter "transaction_timeout"
   *
   * Done here rather than in `backupDatabase` so a dump uploaded from another
   * host is covered too, and shared with `cloneStaging` so both psql --file
   * paths get it. The directives only restate server defaults, so commenting
   * the unknown ones out changes nothing about what the dump builds.
   *
   * ponytail: reads the dump into memory, like the Supabase import path it
   * borrows from. Stream the preamble instead if a dump ever outgrows the heap.
   */
  private async makeDumpPortable(file: string): Promise<void> {
    const sql = await fs.readFile(file, 'utf8');
    // The portable list, not the target's own pg_settings: the restore target
    // may be another host entirely (cloneStaging), so there is no one catalog
    // to ask. Erring towards commenting out is safe for these directives.
    const { sql: rewritten, stripped } = neutralizeUnsupportedSettings(sql, name =>
      PORTABLE_DUMP_SETTINGS.has(name)
    );
    if (stripped.length) await fs.writeFile(file, rewritten, 'utf8');
  }

  /**
   * Unpack a full project archive back into the backup directory.
   *
   * Deliberately extraction and not restoration: the database half becomes a
   * normal `.sql` dump the existing restore path can read, and the storage
   * objects land on disk where an operator can put them back deliberately.
   * Writing a destructive, untested "restore everything" path would be worse
   * than the missing feature it replaces.
   */
  async extractArchive(input: { file: string }): Promise<{ database: BackupFile | null; files: string[] }> {
    const { extractable } = classifyBackup(input.file ?? '');
    if (!extractable) throw new HttpException(`${input.file} is not a full project archive`, 400);

    const source = this.resolveInsideRoot(input.file);
    await this.assertReadable(source);
    const entries = readTar(await fs.readFile(source));

    const base = input.file.replace(/\.tar$/i, '');
    const outDir = this.resolveInsideRoot(`${base}-extracted`);
    await fs.mkdir(outDir, { recursive: true });

    let database: BackupFile | null = null;
    const files: string[] = [];
    for (const entry of entries) {
      // Entry names come from an archive; keep them inside the extraction dir.
      const target = path.resolve(outDir, entry.name);
      if (target !== outDir && !target.startsWith(outDir + path.sep)) {
        throw new HttpException(`archive entry escapes the extraction directory: ${entry.name}`, 400);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entry.data);
      if (entry.name === 'database.sql') {
        // Promote the dump to a first-class backup row so Restore can see it.
        const dump = this.resolveInsideRoot(`${base}-database.sql`);
        await fs.writeFile(dump, entry.data);
        database = await this.describe(dump);
      } else {
        files.push(entry.name);
      }
    }
    logActivity('info', 'job', `[backup] extracted ${entries.length} entries from ${input.file}`);
    return { database, files };
  }

  async exportProject(outputName = `motherbase-project-${timestamp()}.json`): Promise<BackupFile> {
    const file = this.resolveInsideRoot(outputName);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const [schema, policies, edgeFunctions] = await Promise.all([
      this.di.SchemaService.listGraph(),
      this.di.RlsService.listTables(),
      this.di.EdgeFunctionService.list().catch(() => []),
    ]);
    const payload = {
      exportedAt: new Date().toISOString(),
      schema,
      policies,
      edgeFunctions,
      secrets: 'omitted',
    };
    await fs.writeFile(file, JSON.stringify(payload, null, 2));
    return this.describe(file);
  }

  /**
   * The database dump already contains everything relational (config,
   * settings, edge function code, RLS policies, users) since `pg_dump` covers
   * every schema in the project's own database. The one thing it never
   * touches is storage: bucket objects live on disk or in MinIO/S3, outside
   * Postgres. This bundles both into one tar so "full project" is a single
   * file: the SQL dump plus every ready file's bytes under storage/.
   */
  async exportFullProject(outputName = `motherbase-full-${timestamp()}.tar`): Promise<BackupFile> {
    const dbDump = await this.backupDatabase(`motherbase-full-db-${timestamp()}.sql`);

    const files = await this.di.prisma.file.findMany({
      where: { status: FileStatus.ready },
      select: { id: true, bucket: true, key: true, size: true },
    });

    // Cluster-level and therefore invisible to pg_dump: the anon/authenticated/
    // service_role logins every RLS policy and GRANT in the dump refers to.
    // Restoring into the same cluster finds them already there, which is why
    // this was never noticed; restoring onto a fresh host does not, and the
    // dump aborts on the first `CREATE POLICY ... TO anon`.
    const roles = await this.dumpRoles();

    // What is in the bundle, and the one category that is not. Anyone holding
    // this tar a year from now should not have to read this file to find out
    // that the environment secrets were never in it.
    const manifest = Buffer.from(
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          contents: {
            'database.sql': 'pg_dump of every schema, with GRANTs; excludes object ownership',
            'roles.sql': roles ? 'cluster roles, without passwords' : 'not included (pg_dumpall unavailable)',
            'storage/': `${files.length} ready object(s), as <bucket>/<key>`,
          },
          notIncluded: [
            'environment secrets (BETTER_AUTH_SECRET, DATABASE_URL, S3 credentials): restoring onto a new host needs these supplied separately, or every existing session and signed URL breaks',
            'role passwords',
            'storage objects not in the ready state',
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    // Streamed: the dump and every storage object go to disk one chunk at a
    // time, so peak memory is one chunk, not the dump plus every file (twice).
    const store = this.di.StorageService;
    const dumpSize = (await fs.stat(dbDump.file.path)).size;
    async function* entries(): AsyncGenerator<TarStreamEntry> {
      yield { name: 'database.sql', size: dumpSize, body: createReadStream(dbDump.file.path) };
      if (roles) {
        const data = Buffer.from(roles, 'utf8');
        yield { name: 'roles.sql', size: data.length, body: [data] };
      }
      for (const f of files) {
        const object = await store.adminStreamFile(f.id);
        // The driver's length is the truth about the bytes; the row is the fallback (-1 = unknown).
        const size = object.contentLength >= 0 ? object.contentLength : f.size;
        yield { name: `storage/${f.bucket}/${f.key}`, size, body: object.body };
      }
      yield { name: 'manifest.json', size: manifest.length, body: [manifest] };
    }

    const file = this.resolveInsideRoot(outputName);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await pipeline(Readable.from(tarStream(entries())), createWriteStream(file));
    } catch (err) {
      await fs.unlink(file).catch(() => {}); // never leave a truncated .tar the console would offer
      throw err;
    }
    await fs.unlink(dbDump.file.path).catch(() => {}); // superseded by the copy inside the tar

    return this.describe(file);
  }

  async cloneStaging(input: { targetDatabaseUrl: string; confirm?: string }): Promise<CommandResult & { backup: BackupFile }> {
    if (input.confirm !== 'CLONE') throw new HttpException('Clone requires confirm=CLONE', 400);
    if (!input.targetDatabaseUrl?.trim()) throw new HttpException('targetDatabaseUrl is required', 400);
    const backup = await this.backupDatabase(`motherbase-clone-${timestamp()}.sql`);
    await this.makeDumpPortable(backup.file.path);
    const restore = await this.run('psql', [
      '--dbname',
      toLibpqUrl(input.targetDatabaseUrl),
      '--set',
      'ON_ERROR_STOP=1',
      '--file',
      backup.file.path,
    ]);
    return { backup: backup.file, ...restore };
  }

  /**
   * Take a backup file the operator uploaded and put it in BACKUP_DIR.
   *
   * The counterpart to `/backups/download`, which had none: every restore path
   * reads from BACKUP_DIR, so a dump that had been downloaded (or taken off a
   * dead host) could not be fed back in through the product at all. Restoring
   * meant an operator with shell access on the box.
   *
   * The uploaded file lands under a generated name, never the client's own, so
   * an upload can never overwrite an existing backup. It is classified like any
   * other row, so an unrecognised extension is stored inert rather than being
   * offered to psql.
   */
  async importBackup(input: { tempPath: string; originalName: string }): Promise<BackupFile> {
    const base = path.basename(String(input.originalName ?? '').trim());
    const { kind } = classifyBackup(base);
    if (kind === 'unknown') {
      throw new HttpException('Only .sql dumps, .tar project archives and .json exports can be uploaded', 400);
    }
    // Keep the extension (the kind is read from it) and drop everything else
    // the client chose about the name.
    const extension = path.extname(base);
    const dest = this.resolveInsideRoot(`motherbase-uploaded-${timestamp()}${extension}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // copy + unlink, not rename: the multer temp dir is under os.tmpdir() and
    // is routinely on a different device from BACKUP_DIR, where rename fails
    // with EXDEV.
    await fs.copyFile(input.tempPath, dest);
    logActivity('info', 'job', `[backup] imported an uploaded ${kind} backup as ${path.basename(dest)}`);
    return this.describe(dest);
  }

  /** Validated, existing path to a local dump, for streaming it back to the operator. */
  async localFilePath(name: string): Promise<string> {
    const file = this.resolveInsideRoot(name);
    await this.assertReadable(file);
    return file;
  }

  private resolveInsideRoot(name: string): string {
    const cleanName = String(name ?? '').trim();
    if (!cleanName) throw new HttpException('Backup file name is required', 400);
    if (path.isAbsolute(cleanName)) throw new HttpException('Backup path must be relative to BACKUP_DIR', 400);
    const resolved = path.resolve(this.root(), cleanName);
    const root = this.root();
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new HttpException('Backup path escapes BACKUP_DIR', 400);
    }
    return resolved;
  }

  private async assertReadable(file: string): Promise<void> {
    try {
      await fs.access(file);
    } catch {
      throw new HttpException(`Backup file not found: ${path.basename(file)}`, 404);
    }
  }

  private async describe(file: string): Promise<BackupFile> {
    const stat = await fs.stat(file);
    const name = path.basename(file);
    return {
      name,
      path: file,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
      ...classifyBackup(name),
    };
  }

  /**
   * Cluster roles, without passwords, for the full-project archive.
   *
   * Best effort: pg_dumpall may be missing from the image or refused by a
   * restricted database user, and neither is a reason to fail a backup whose
   * database and storage halves succeeded. It returns null and the manifest
   * says the archive has no roles.sql.
   */
  private async dumpRoles(): Promise<string | null> {
    try {
      const { stdout } = await this.run('pg_dumpall', [
        '--dbname',
        toLibpqUrl(env.DATABASE_URL),
        '--roles-only',
        '--no-role-passwords',
      ]);
      return stdout.trim() ? stdout : null;
    } catch {
      logActivity('warn', 'job', '[backup] could not dump cluster roles; archive will have no roles.sql');
      return null;
    }
  }

  private run(command: string, args: string[]): Promise<CommandResult> {
    return runCommand(command, args);
  }
}

