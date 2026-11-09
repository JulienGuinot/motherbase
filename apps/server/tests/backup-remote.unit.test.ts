import { describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import { BackupRemote } from '../services/admin/backup-remote';

/** Fake S3 client that records commands and answers by command class name. */
function fakeS3(objects: { Key: string; Size: number; LastModified: Date }[] = []) {
  const sent: any[] = [];
  const client = {
    send: vi.fn(async (cmd: any) => {
      sent.push(cmd);
      switch (cmd.constructor.name) {
        case 'ListObjectsV2Command':
          return { Contents: objects };
        default:
          return {};
      }
    }),
  };
  return { client: client as any, sent };
}

// ── BackupRemote (S3) ────────────────────────────────────────────────────────

describe('BackupRemote', () => {
  it('uploads to BACKUP_BUCKET and never the public bucket', async () => {
    const { client, sent } = fakeS3();
    const remote = new BackupRemote(client);
    const tmp = path.join(os.tmpdir(), `mb-backup-${Date.now()}.sql`);
    await fs.writeFile(tmp, 'dump-bytes');

    await remote.upload(tmp, 'motherbase-db.sql');

    expect(sent).toHaveLength(1);
    expect(sent[0].constructor.name).toBe('PutObjectCommand');
    expect(sent[0].input.Bucket).toBe('backups'); // BACKUP_BUCKET default
    expect(sent[0].input.Bucket).not.toBe('public');
    expect(sent[0].input.Key).toBe('motherbase-db.sql');
    expect(sent[0].input.ContentLength).toBe(Buffer.byteLength('dump-bytes'));
    expect(sent[0].input.Body).toBeInstanceOf(Readable);
    await fs.unlink(tmp).catch(() => {});
  });

  it('pruneRemote keeps exactly N newest and deletes the rest', async () => {
    const objects = [
      { Key: 'a', Size: 1, LastModified: new Date('2026-01-01') },
      { Key: 'b', Size: 1, LastModified: new Date('2026-01-05') },
      { Key: 'c', Size: 1, LastModified: new Date('2026-01-03') },
      { Key: 'd', Size: 1, LastModified: new Date('2026-01-04') },
      { Key: 'e', Size: 1, LastModified: new Date('2026-01-02') },
    ];
    const { client, sent } = fakeS3(objects);
    const remote = new BackupRemote(client);

    const deleted = await remote.prune(2);

    // Newest two = b (01-05), d (01-04). Deleted = c, e, a.
    expect(deleted.sort()).toEqual(['a', 'c', 'e']);
    const deleteCmds = sent.filter(c => c.constructor.name === 'DeleteObjectsCommand');
    expect(deleteCmds).toHaveLength(1);
    expect(deleteCmds[0].input.Bucket).toBe('backups');
    expect(deleteCmds[0].input.Delete.Objects.map(({ Key }: any) => Key).sort()).toEqual(['a', 'c', 'e']);
  });

  it('paginates S3 listings with ContinuationToken beyond 1,000 objects', async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      Key: `backup-${index}`,
      Size: index,
      LastModified: new Date('2026-01-01'),
    }));
    const send = vi.fn(async (command: any) => {
      if (command.input.ContinuationToken === undefined) {
        return { Contents: firstPage, NextContinuationToken: 'page-2' };
      }
      return {
        Contents: [{ Key: 'backup-1000', Size: 1_000, LastModified: new Date('2026-01-02') }],
      };
    });
    const remote = new BackupRemote({ send } as any);

    const backups = await remote.list();

    expect(backups).toHaveLength(1_001);
    expect(backups[0].key).toBe('backup-1000');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.ContinuationToken).toBe('page-2');
  });

  it('streams downloads to files and writable consumers', async () => {
    const payload = [Buffer.from('large-'), Buffer.from('backup')];
    const send = vi.fn(async () => ({ Body: Readable.from(payload) }));
    const remote = new BackupRemote({ send } as any);
    const file = path.join(os.tmpdir(), `mb-download-${Date.now()}.sql`);

    await remote.download('backup.sql', file);
    expect(await fs.readFile(file, 'utf8')).toBe('large-backup');

    const received: Buffer[] = [];
    const consumer = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) {
        received.push(Buffer.from(chunk));
        setImmediate(done);
      },
    });
    await remote.download('backup.sql', consumer);
    expect(Buffer.concat(received).toString()).toBe('large-backup');
    await fs.unlink(file).catch(() => {});
  });

  it('removes a partial file when the S3 download stream fails', async () => {
    const body = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('network interrupted');
      })()
    );
    const remote = new BackupRemote({ send: vi.fn(async () => ({ Body: body })) } as any);
    const file = path.join(os.tmpdir(), `mb-download-error-${Date.now()}.sql`);

    await expect(remote.download('backup.sql', file)).rejects.toThrow('network interrupted');
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('deletes in S3 batches with at most four requests in flight', async () => {
    const objects = Array.from({ length: 5_001 }, (_, index) => ({
      Key: `backup-${index}`,
      Size: 1,
      LastModified: new Date(index),
    }));
    let active = 0;
    let maxActive = 0;
    const deleteSizes: number[] = [];
    const send = vi.fn(async (command: any) => {
      if (command.constructor.name === 'ListObjectsV2Command') return { Contents: objects };
      active += 1;
      maxActive = Math.max(maxActive, active);
      deleteSizes.push(command.input.Delete.Objects.length);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return {};
    });
    const remote = new BackupRemote({ send } as any);

    expect(await remote.prune(0)).toHaveLength(5_001);
    expect(deleteSizes).toEqual([1_000, 1_000, 1_000, 1_000, 1_000, 1]);
    expect(maxActive).toBe(4);
  });

  it('surfaces per-object S3 deletion errors', async () => {
    const send = vi.fn(async (command: any) =>
      command.constructor.name === 'ListObjectsV2Command'
        ? { Contents: [{ Key: 'broken', Size: 1, LastModified: new Date() }] }
        : { Errors: [{ Key: 'broken', Code: 'AccessDenied' }] }
    );
    const remote = new BackupRemote({ send } as any);

    await expect(remote.prune(0)).rejects.toMatchObject({ statusCode: 502 });
  });
});
