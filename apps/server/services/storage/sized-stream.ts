import type { Hash } from 'crypto';
import { Readable } from 'stream';

async function* verifySize(source: Readable, expected: number, hash?: Hash): AsyncGenerator<Buffer> {
  let received = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.length;
    if (received > expected) throw new Error(`Upload exceeded its declared size of ${expected} bytes`);
    hash?.update(bytes);
    yield bytes;
  }
  if (received !== expected) throw new Error(`Upload ended at ${received} bytes; expected ${expected}`);
}

/**
 * Verify byte count while retaining normal Node stream backpressure. `hash`,
 * when given, sees every byte on the way through: that is how an object gets
 * its MD5 ETag without a second read.
 */
export function exactSizeStream(source: Readable, expected: number, hash?: Hash): Readable {
  return Readable.from(verifySize(source, expected, hash), { objectMode: false });
}
