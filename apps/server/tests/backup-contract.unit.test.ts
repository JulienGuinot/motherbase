import { describe, expect, it } from 'vitest';
import { classifyBackup } from '../services/admin/backup.service';
import { readTar, tarStream, writeTar } from '../services/admin/tar-writer';

describe('classifyBackup', () => {
  it('only calls a plain SQL dump restorable', () => {
    // Restore shells out to `psql --file`. Everything else in this directory is
    // either an archive or a JSON document, and the console used to draw the
    // same Restore button on all three.
    expect(classifyBackup('motherbase-db-2026.sql')).toEqual({
      kind: 'database',
      restorable: true,
      extractable: false,
    });
  });

  it('marks a full archive as extractable but not restorable', () => {
    expect(classifyBackup('motherbase-full-2026.tar')).toEqual({
      kind: 'full',
      restorable: false,
      extractable: true,
    });
  });

  it('marks a project export as neither', () => {
    expect(classifyBackup('motherbase-project-2026.json')).toEqual({
      kind: 'export',
      restorable: false,
      extractable: false,
    });
  });

  it('refuses to guess about a file it does not recognise', () => {
    expect(classifyBackup('notes.txt').restorable).toBe(false);
    expect(classifyBackup('notes.txt').kind).toBe('unknown');
  });

  it('is case-insensitive about the extension', () => {
    expect(classifyBackup('DUMP.SQL').restorable).toBe(true);
  });
});

describe('readTar', () => {
  it('reads back exactly what writeTar wrote', () => {
    // A full project archive is otherwise a file the console offers and nothing
    // in the product can open again.
    const entries = [
      { name: 'database.sql', data: Buffer.from('SELECT 1;\n') },
      // Not a multiple of 512, so the padding path is exercised.
      { name: 'storage/avatars/a.png', data: Buffer.from([1, 2, 3, 4, 5]) },
    ];

    const round = readTar(writeTar(entries));

    expect(round.map(e => e.name)).toEqual(['database.sql', 'storage/avatars/a.png']);
    expect(round[0].data.toString()).toBe('SELECT 1;\n');
    expect([...round[1].data]).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles an empty entry', () => {
    const round = readTar(writeTar([{ name: 'empty', data: Buffer.alloc(0) }]));
    expect(round).toHaveLength(1);
    expect(round[0].data).toHaveLength(0);
  });

  it('round-trips a name past the 100-byte USTAR limit', () => {
    // Not an edge case: an entry is `storage/<bucket>/<key>` and a storage key
    // may be 1024 characters. The writer used to throw on the first one, which
    // aborted the whole full-project backup rather than one file in it.
    const name = `storage/uploads/${'deep/'.repeat(30)}photo.png`;
    expect(name.length).toBeGreaterThan(100);

    const round = readTar(writeTar([{ name, data: Buffer.from('bytes') }]));

    expect(round).toHaveLength(1); // the long-name header is not an entry of its own
    expect(round[0].name).toBe(name);
    expect(round[0].data.toString()).toBe('bytes');
  });

  it('keeps long and short names straight when they are interleaved', () => {
    const long = `storage/uploads/${'x'.repeat(200)}.bin`;
    const round = readTar(
      writeTar([
        { name: 'database.sql', data: Buffer.from('a') },
        { name: long, data: Buffer.from('b') },
        { name: 'manifest.json', data: Buffer.from('c') },
      ])
    );
    expect(round.map(e => e.name)).toEqual(['database.sql', long, 'manifest.json']);
    expect(round.map(e => e.data.toString())).toEqual(['a', 'b', 'c']);
  });

  it('refuses a truncated archive instead of returning half an entry', () => {
    const archive = writeTar([{ name: 'database.sql', data: Buffer.alloc(2000, 65) }]);
    expect(() => readTar(archive.subarray(0, 900))).toThrow(/truncated/);
  });
});

describe('tarStream', () => {
  const collect = async (gen: AsyncIterable<Buffer>) => {
    const chunks: Buffer[] = [];
    for await (const chunk of gen) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  async function* source(items: Array<{ name: string; chunks: string[] }>) {
    for (const { name, chunks } of items) {
      yield { name, size: Buffer.byteLength(chunks.join('')), body: chunks.map(c => Buffer.from(c)) };
    }
  }

  it('produces byte-for-byte what writeTar does, however the body is chunked', async () => {
    const long = `storage/uploads/${'x'.repeat(200)}.bin`;
    const items = [
      { name: 'database.sql', chunks: ['SELECT ', '1;\n'] },
      { name: long, chunks: ['a'.repeat(1000), 'b'.repeat(24)] }, // exactly 2 blocks, no padding
      { name: 'empty', chunks: [] },
    ];
    const streamed = await collect(tarStream(source(items)));
    const buffered = writeTar(items.map(i => ({ name: i.name, data: Buffer.from(i.chunks.join('')) })));

    // Headers carry an mtime in seconds; equal unless the clock ticked mid-test.
    expect(readTar(streamed)).toEqual(readTar(buffered));
    expect(streamed.length).toBe(buffered.length);
  });

  it('throws when a body is not the size it declared', async () => {
    const bad = async function* () {
      yield { name: 'a', size: 10, body: [Buffer.from('short')] };
    };
    await expect(collect(tarStream(bad()))).rejects.toThrow(/declared 10/);
    const over = async function* () {
      yield { name: 'a', size: 2, body: [Buffer.from('too long')] };
    };
    await expect(collect(tarStream(over()))).rejects.toThrow(/declared 2/);
  });
});
