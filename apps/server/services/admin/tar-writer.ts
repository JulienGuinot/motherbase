// Minimal USTAR writer: just enough to bundle a handful of backup files into
// one archive without a new dependency. No sparse or device-file support:
// every entry here is a plain file.
//
// Long names ARE supported, through the GNU `L` extension, because they are not
// an edge case here: an entry is `storage/<bucket>/<key>` and a storage key is
// allowed 1024 characters, far past the 100-byte USTAR name field. The archive
// is built in one pass, so a single long name would abort the whole backup.

const BLOCK = 512;
/** USTAR stores the size as 11 octal digits, so this is the largest it can hold. */
const MAX_ENTRY_SIZE = 0o77777777777; // 8 GiB - 1
const LONG_NAME_MARKER = '././@LongLink';
const TYPE_FILE = '0';
const TYPE_LONG_NAME = 'L';

function header(name: string, size: number, typeflag: string): Buffer {
  if (size > MAX_ENTRY_SIZE) {
    // Silently writing a 12-digit octal here would overflow into the mtime
    // field and produce an archive that reads back as corrupt.
    throw new Error(`tar entry "${name}" is larger than the ${MAX_ENTRY_SIZE} byte tar limit`);
  }
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, 100, 'utf8'); // truncated on purpose; the real name rode in the L entry
  buf.write('0000644\0', 100, 8, 'utf8'); // mode
  buf.write('0000000\0', 108, 8, 'utf8'); // uid
  buf.write('0000000\0', 116, 8, 'utf8'); // gid
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  buf.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'utf8');
  buf.write('        ', 148, 8, 'utf8'); // checksum placeholder (spaces)
  buf.write(typeflag, 156, 1, 'utf8');
  buf.write('ustar\0', 257, 6, 'utf8');
  buf.write('00', 263, 2, 'utf8');

  let checksum = 0;
  for (const byte of buf) checksum += byte;
  buf.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return buf;
}

/** Zero bytes rounding `length` up to the next 512-byte block. */
function padding(length: number): Buffer {
  return Buffer.alloc((BLOCK - (length % BLOCK)) % BLOCK);
}

/** Everything that precedes an entry's bytes: the GNU long-name entry (when needed) and its header. */
function entryHead(name: string, size: number): Buffer {
  const parts: Buffer[] = [];
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 100) {
    // GNU long name: an `L` entry whose body is the real name, NUL-terminated.
    const payload = Buffer.concat([nameBytes, Buffer.alloc(1)]);
    parts.push(header(LONG_NAME_MARKER, payload.length, TYPE_LONG_NAME), payload, padding(payload.length));
  }
  parts.push(header(name, size, TYPE_FILE));
  return Buffer.concat(parts);
}

const END_OF_ARCHIVE = Buffer.alloc(BLOCK * 2); // two zero blocks terminate the archive

/** Builds a tar archive (no compression) from in-memory entries. */
export function writeTar(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(entryHead(entry.name, entry.data.length), entry.data, padding(entry.data.length));
  }
  parts.push(END_OF_ARCHIVE);
  return Buffer.concat(parts);
}

export interface TarStreamEntry {
  name: string;
  /** Declared up front: a tar header carries the size before the bytes. */
  size: number;
  body: AsyncIterable<Buffer | string> | Iterable<Buffer | string>;
}

/**
 * Same bytes as {@link writeTar}, produced one chunk at a time, so an archive
 * of many large files never has to fit in memory. Pass `entries` as a lazy
 * generator to also open each source only when its turn comes.
 *
 * A body that does not match its declared size throws: the header is already
 * out, so carrying on would shift every later entry and yield a corrupt archive.
 */
export async function* tarStream(entries: AsyncIterable<TarStreamEntry>): AsyncGenerator<Buffer> {
  for await (const { name, size, body } of entries) {
    yield entryHead(name, size);
    let written = 0;
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      written += buf.length;
      if (written > size) break;
      yield buf;
    }
    if (written !== size) throw new Error(`tar entry "${name}" is ${written} bytes, declared ${size}`);
    yield padding(size);
  }
  yield END_OF_ARCHIVE;
}

/**
 * Reads back what {@link writeTar} produced.
 *
 * Only what the writer emits: regular files, plus the GNU `L` long-name entries
 * it writes for anything over 100 bytes. A full project archive is otherwise a
 * file the console offers and nothing in the product can open again.
 */
export function readTar(archive: Buffer): Array<{ name: string; data: Buffer }> {
  /** Header fields are NUL-padded, so read up to the first zero byte. */
  const field = (buf: Buffer): string => {
    const end = buf.indexOf(0);
    return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8').trim();
  };

  const entries: Array<{ name: string; data: Buffer }> = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  while (offset + BLOCK <= archive.length) {
    const head = archive.subarray(offset, offset + BLOCK);
    // Two zero blocks terminate the archive; one is enough to stop reading.
    if (head.every(byte => byte === 0)) break;

    const name = field(head.subarray(0, 100));
    const size = parseInt(field(head.subarray(124, 136)), 8);
    if (!name || !Number.isFinite(size) || size < 0) throw new Error('corrupt tar header');

    const start = offset + BLOCK;
    if (start + size > archive.length) throw new Error(`tar entry "${name}" is truncated`);
    const body = archive.subarray(start, start + size);
    offset = start + size + ((BLOCK - (size % BLOCK)) % BLOCK);

    // 0x30 is the digit "0"; a zero byte means the same thing. 0x4c is "L".
    const typeflag = head[156];
    if (typeflag === 0x4c) {
      // The name for the NEXT entry, which carries a truncated one in its header.
      pendingLongName = body.subarray(0, body.indexOf(0) === -1 ? body.length : body.indexOf(0)).toString('utf8');
      continue;
    }
    if (typeflag === 0x30 || typeflag === 0) entries.push({ name: pendingLongName ?? name, data: body });
    pendingLongName = null;
  }
  return entries;
}
