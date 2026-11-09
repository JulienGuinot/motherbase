import { describe, expect, it } from 'vitest';
import { writeTar } from '../services/admin/tar-writer';

/** Minimal ustar reader, just enough to verify what writeTar produced. */
function readTar(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const entries: Array<{ name: string; data: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, ''), 8);
    offset += 512;
    entries.push({ name, data: buf.subarray(offset, offset + size) });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe('writeTar', () => {
  it('round-trips multiple entries', () => {
    const archive = writeTar([
      { name: 'database.sql', data: Buffer.from('select 1;') },
      { name: 'storage/avatars/a.png', data: Buffer.from('binary-ish-content') },
    ]);
    expect(archive.length % 512).toBe(0);

    const entries = readTar(archive);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('database.sql');
    expect(entries[0].data.toString('utf8')).toBe('select 1;');
    expect(entries[1].name).toBe('storage/avatars/a.png');
    expect(entries[1].data.toString('utf8')).toBe('binary-ish-content');
  });

  it('handles an empty file', () => {
    const archive = writeTar([{ name: 'empty.txt', data: Buffer.alloc(0) }]);
    const entries = readTar(archive);
    expect(entries).toEqual([{ name: 'empty.txt', data: Buffer.alloc(0) }]);
  });

  it('emits a long name as a GNU @LongLink entry, the way real tar reads it', () => {
    // Verified with the naive reader above rather than our own readTar, because
    // the point is what an outside tar sees: an `L` entry carrying the full
    // name, then the file itself. `storage/<bucket>/<key>` routinely passes 100
    // bytes (a key may be 1024), and this used to throw and abort the whole
    // full-project backup.
    const name = `storage/uploads/${'deep/'.repeat(25)}photo.png`;
    expect(name.length).toBeGreaterThan(100);

    const entries = readTar(writeTar([{ name, data: Buffer.from('bytes') }]));

    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('././@LongLink');
    expect(entries[0].data.subarray(0, entries[0].data.indexOf(0)).toString('utf8')).toBe(name);
    expect(entries[1].data.toString('utf8')).toBe('bytes');
  });
});
