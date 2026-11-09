// Supabase does not hand back the source you deployed.
//
// `GET /v1/projects/<ref>/functions/<slug>/body` returns an **eszip**: Deno's
// binary serialisation of a whole module graph, which is what the edge runtime
// actually boots. It is not text. Writing it into a `text` column fails with:
//
//   invalid byte sequence for encoding "UTF8": 0x00
//
// The official way to read one is to run `eszip` (Rust) or the Deno wasm build
// of it; the Supabase CLI shells out to a Docker image to do exactly that. That
// is a lot of machinery to read a few hundred lines of JavaScript back out, so
// this is a reader for the parts of the format the importer needs: the header,
// and the sources the header points at. It verifies nothing (Supabase signed
// nothing) and it ignores source maps and npm resolution.
//
// Format (denoland/eszip, src/v2.rs). A "section" is `u32be length | body |
// digest`, where the digest length comes from the options section:
//
//   magic            8 bytes   ESZIP_V2 | ESZIP2.1 | ESZIP2.2 | ESZIP2.3
//   options          section   v2.2+ only. Pairs of [option id, value];
//                              id 0 = checksum kind (0 none, 1 sha256, 2
//                              xxhash3), id 1 = explicit digest size.
//   modules header   section   the entry table, see readHeader below
//   npm snapshot     section   v2.1+ only, skipped
//   sources          section   every module's source, back to back, each
//                              followed by its digest. The header's offsets
//                              index into this body.
//   source maps      section   skipped
//
// Pre-2.2 files carry no options section and always hash with sha256.

import { brotliDecompressSync } from 'node:zlib';

/** Module entry kinds in the header frame. Redirect/npm entries carry no source. */
const KIND_MODULE = 0;
const KIND_REDIRECT = 1;
const KIND_NPM = 2;

// Module kinds, from the last byte of a module entry. 0 js, 1 json, 2 jsonc,
// 3 opaque data, 4 wasm. The last two are bytes, not text: a `.wasm` module's
// "source" is the binary, NULs and all, which is the very thing that must not
// reach a `text` column. Only text kinds come back out of the parser.
const TEXT_MODULE_KINDS = new Set([0, 1, 2]);

const MAGICS = ['ESZIP_V2', 'ESZIP2.1', 'ESZIP2.2', 'ESZIP2.3'];

/** Supabase's edge runtime may brotli-wrap the eszip; the wrapper says so. */
const BROTLI_MAGIC = 'EZBR';

export interface EszipModule {
  specifier: string;
  source: string;
}

export interface EszipEntry {
  /** The module the function starts at, best-effort (see pickEntryModule). */
  source: string;
  specifier: string;
  /** Other `file://` modules in the graph, by specifier. Not merged into source. */
  otherFiles: string[];
}

/** True when `bytes` looks like an eszip rather than a plain source file. */
export function looksLikeEszip(bytes: Buffer): boolean {
  if (bytes.length >= 4 && bytes.toString('latin1', 0, 4) === BROTLI_MAGIC) return true;
  return bytes.length >= 8 && MAGICS.includes(bytes.toString('latin1', 0, 8));
}

class Reader {
  offset = 0;
  constructor(private readonly bytes: Buffer) {}

  u8(): number {
    this.need(1);
    return this.bytes[this.offset++];
  }

  u32(): number {
    this.need(4);
    const value = this.bytes.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  take(length: number): Buffer {
    this.need(length);
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  /** `u32 length | body | digest`. Returns the body and leaves the cursor past the digest. */
  section(digestSize: number): Buffer {
    const body = this.take(this.u32());
    this.take(digestSize);
    return body;
  }

  private need(length: number): void {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('eszip archive is truncated or not in a format this importer can read');
    }
  }
}

interface HeaderModule {
  specifier: string;
  sourceOffset: number;
  sourceLength: number;
}

function readHeader(header: Buffer): HeaderModule[] {
  const reader = new Reader(header);
  const modules: HeaderModule[] = [];
  while (reader.offset < header.length) {
    const specifier = reader.take(reader.u32()).toString('utf8');
    const kind = reader.u8();
    if (kind === KIND_MODULE) {
      const sourceOffset = reader.u32();
      const sourceLength = reader.u32();
      reader.u32(); // source map offset
      reader.u32(); // source map length
      const moduleKind = reader.u8();
      if (sourceLength > 0 && TEXT_MODULE_KINDS.has(moduleKind)) {
        modules.push({ specifier, sourceOffset, sourceLength });
      }
    } else if (kind === KIND_REDIRECT) {
      reader.take(reader.u32());
    } else if (kind === KIND_NPM) {
      reader.u32();
    } else {
      throw new Error(`eszip header holds an entry kind this importer does not know (${kind})`);
    }
  }
  return modules;
}

/**
 * Digest size from the options body.
 *
 * v2.2+ defaults to NO checksum when the options say nothing (denoland/eszip,
 * `Options::default_for_version`), so the default here is 0 and only an
 * explicit option lengthens it. Pre-2.2 archives carry no options section at
 * all and always hash with sha256, which the caller handles.
 */
function digestSizeFromOptions(options: Buffer): number {
  let size = 0;
  for (let i = 0; i + 1 < options.length; i += 2) {
    const [id, value] = [options[i], options[i + 1]];
    if (id === 0) size = value === 0 ? 0 : value === 2 ? 8 : 32;
    if (id === 1) size = value;
  }
  return size;
}

/** Every module in the graph that carries source, in header order. */
export function parseEszip(input: Buffer): EszipModule[] {
  const bytes =
    input.toString('latin1', 0, 4) === BROTLI_MAGIC ? brotliDecompressSync(input.subarray(4)) : input;

  const magic = bytes.toString('latin1', 0, 8);
  if (!MAGICS.includes(magic)) {
    throw new Error('not an eszip archive');
  }

  const reader = new Reader(bytes);
  reader.take(8);

  // v2.2 put the checksum config in a section of its own, and that section's
  // own digest is sized by what it declares: read the body first, then skip.
  let digestSize = 32;
  if (magic === 'ESZIP2.2' || magic === 'ESZIP2.3') {
    const options = reader.take(reader.u32());
    digestSize = digestSizeFromOptions(options);
    reader.take(digestSize);
  }

  const header = readHeader(reader.section(digestSize));
  if (magic !== 'ESZIP_V2') reader.section(digestSize); // npm snapshot

  const sources = reader.take(reader.u32());
  return header.map(module => {
    const end = module.sourceOffset + module.sourceLength;
    if (end > sources.length) {
      throw new Error('eszip source offsets fall outside the archive; the format has moved on');
    }
    return {
      specifier: module.specifier,
      source: sources.toString('utf8', module.sourceOffset, end),
    };
  });
}

/**
 * The module a function starts at.
 *
 * A bundle holds the function's own files plus every remote dependency it
 * pulled in. Only the local ones are worth importing, and the entry is
 * conventionally `index.ts`. Ties break on the shallowest path, which is the
 * one a deeper helper would import.
 *
 * "Local" is everything that is not fetched from somewhere: Supabase's own
 * deploys label their files with a plain relative specifier
 * (`functions/send-sms/index.ts`), while a hand-built eszip uses `file://`.
 * Matching on `file://` alone found nothing in a real bundle and reported
 * every function as holding no source.
 */
const REMOTE_SPECIFIER = /^(?:https?|npm|jsr|node|data|blob|deno):/i;

function isLocal(specifier: string): boolean {
  return !REMOTE_SPECIFIER.test(specifier);
}

export function pickEntryModule(modules: EszipModule[]): EszipEntry | null {
  const local = modules.filter(module => isLocal(module.specifier));
  if (local.length === 0) return null;

  const score = (specifier: string): number =>
    (/\/index\.[cm]?[jt]sx?$/.test(specifier) ? 0 : 1000) + specifier.split('/').length;
  const sorted = [...local].sort((a, b) => score(a.specifier) - score(b.specifier));

  return {
    specifier: sorted[0].specifier,
    source: sorted[0].source,
    otherFiles: sorted.slice(1).map(module => module.specifier.replace(/^file:\/\//, '')),
  };
}
