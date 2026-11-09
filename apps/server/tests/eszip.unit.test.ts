import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { looksLikeEszip, parseEszip, pickEntryModule } from '../services/admin/eszip';

// ── eszip ────────────────────────────────────────────────────────────────────
// Supabase answers `/functions/<slug>/body` with a deployed eszip bundle, and
// an eszip is full of NUL bytes: writing one into a Postgres `text` column is
// what made every edge-function import fail with SQLSTATE 22021. These build
// archives by hand (there is no Deno here to produce one) and read them back.

const DIGEST = 32;

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

/** `u32 length | body | digest`, the archive's one repeated shape. */
function section(body: Buffer): Buffer {
  return Buffer.concat([u32(body.length), body, Buffer.alloc(DIGEST)]);
}

function buildEszip(modules: { specifier: string; source: string }[], magic = 'ESZIP2.2'): Buffer {
  const header: Buffer[] = [];
  const sources: Buffer[] = [];
  let offset = 0;

  for (const module of modules) {
    const source = Buffer.from(module.source, 'utf8');
    const specifier = Buffer.from(module.specifier, 'utf8');
    header.push(
      u32(specifier.length),
      specifier,
      Buffer.from([0]), // kind: module
      u32(offset),
      u32(source.length),
      u32(0), // source map offset
      u32(0), // source map length
      Buffer.from([0]) // module kind
    );
    // Each source is followed by its own digest, and the next offset clears it.
    sources.push(source, Buffer.alloc(DIGEST));
    offset += source.length + DIGEST;
  }

  const sourcesBody = Buffer.concat(sources);
  return Buffer.concat([
    Buffer.from(magic, 'latin1'),
    ...(magic === 'ESZIP_V2' ? [] : [section(Buffer.from([0, 1]))]), // options: sha256
    section(Buffer.concat(header)),
    ...(magic === 'ESZIP_V2' ? [] : [section(Buffer.alloc(0))]), // npm snapshot
    u32(sourcesBody.length),
    sourcesBody,
    u32(0), // source maps
  ]);
}

describe('parseEszip', () => {
  it('reads every module back out of a v2.2 archive', () => {
    const bytes = buildEszip([
      { specifier: 'file:///src/index.ts', source: 'Deno.serve(() => new Response("hi"))' },
      { specifier: 'https://esm.sh/foo', source: 'export const foo = 1' },
    ]);

    expect(looksLikeEszip(bytes)).toBe(true);
    expect(parseEszip(bytes)).toEqual([
      { specifier: 'file:///src/index.ts', source: 'Deno.serve(() => new Response("hi"))' },
      { specifier: 'https://esm.sh/foo', source: 'export const foo = 1' },
    ]);
  });

  it('reads a v2.0 archive, which has neither options nor an npm section', () => {
    const bytes = buildEszip([{ specifier: 'file:///src/index.ts', source: 'export default 1' }], 'ESZIP_V2');
    expect(parseEszip(bytes)[0].source).toBe('export default 1');
  });

  it('unwraps a brotli-compressed archive', () => {
    const inner = buildEszip([{ specifier: 'file:///src/index.ts', source: 'const a = 1' }]);
    const wrapped = Buffer.concat([Buffer.from('EZBR', 'latin1'), brotliCompressSync(inner)]);

    expect(looksLikeEszip(wrapped)).toBe(true);
    expect(parseEszip(wrapped)[0].source).toBe('const a = 1');
  });

  it('refuses plain source rather than returning bytes full of NULs', () => {
    const source = Buffer.from('export default () => new Response("hi")');
    expect(looksLikeEszip(source)).toBe(false);
    expect(() => parseEszip(source)).toThrow(/not an eszip/);
  });

  it('refuses a truncated archive instead of slicing past the end', () => {
    const bytes = buildEszip([{ specifier: 'file:///src/index.ts', source: 'const a = 1' }]);
    expect(() => parseEszip(bytes.subarray(0, bytes.length - 20))).toThrow(/truncated|outside/);
  });
});

describe('pickEntryModule', () => {
  it('prefers the local index over a helper and over remote dependencies', () => {
    const entry = pickEntryModule([
      { specifier: 'https://esm.sh/stripe', source: 'remote' },
      { specifier: 'file:///src/lib/pay.ts', source: 'helper' },
      { specifier: 'file:///src/index.ts', source: 'main' },
    ]);

    expect(entry).toEqual({
      specifier: 'file:///src/index.ts',
      source: 'main',
      otherFiles: ['/src/lib/pay.ts'],
    });
  });

  it('falls back to the shallowest local module when nothing is named index', () => {
    const entry = pickEntryModule([
      { specifier: 'file:///src/deep/util.ts', source: 'util' },
      { specifier: 'file:///src/main.ts', source: 'main' },
    ]);
    expect(entry?.source).toBe('main');
  });

  it('returns null when the bundle is all remote', () => {
    expect(pickEntryModule([{ specifier: 'https://esm.sh/foo', source: 'x' }])).toBeNull();
  });

  // What a real Supabase deploy looks like: relative paths, no scheme at all.
  // Matching on `file://` found nothing here and reported every function in the
  // project as holding no source.
  it('treats a scheme-less specifier as local, which is how Supabase labels its own files', () => {
    const entry = pickEntryModule([
      { specifier: 'https://deno.land/std/http/server.ts', source: 'remote' },
      { specifier: 'functions/_shared/env.ts', source: 'shared' },
      { specifier: 'functions/send-sms/mtarget.ts', source: 'helper' },
      { specifier: 'functions/send-sms/index.ts', source: 'main' },
    ]);

    expect(entry?.specifier).toBe('functions/send-sms/index.ts');
    expect(entry?.source).toBe('main');
    expect(entry?.otherFiles).toEqual(['functions/_shared/env.ts', 'functions/send-sms/mtarget.ts']);
  });
});

// ── Real archives ────────────────────────────────────────────────────────────
// Hand-built archives only prove the reader agrees with the writer above it.
// These three are denoland/eszip's own fixtures (src/testdata, v0.109.0),
// base64'd: a v2.0 file, a v2.1 file carrying an npm snapshot, and a v2.3 file
// whose graph holds a `.wasm` module. They are the check that the format read
// here is the format Deno writes.

const REAL = {
  v2_0:
    'RVNaSVBfVjIAAABMAAAAD2ZpbGU6Ly8vanNvbi50cwAAAAAAAAAASwAAAAAAAAD2AAAAABFmaWxlOi8vL2RhdGEuanNvbg' +
    'AAAABrAAAABQAAAAAAAAAAAW3SjqD4uIr/AvoLCgvLvpwoHcusoPPKvRj4p+XkWI8sAAAAkGV4cG9ydCB7IGRlZmF1bHQg' +
    'YXMgZGF0YSB9IGZyb20gIi4vZGF0YS5qc29uIiBhc3NlcnQgewogICAgdHlwZTogImpzb24iCn07Cl10EB46aGEHSBrzIj' +
    'sfn90JlqAlmXFt/PyKZy+/xelDMTIzNAqog9r8SA1GbuBODW2phr146x/dIXjQRpNyPaOo+V1C9AAAARZ7InZlcnNpb24i' +
    'OjMsInNvdXJjZXMiOlsiZmlsZTovLy9qc29uLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCB7IGRlZmF1bHQgYX' +
    'MgZGF0YSB9IGZyb20gXCIuL2RhdGEuanNvblwiIGFzc2VydCB7IHR5cGU6IFwianNvblwiIH07XG4iXSwibmFtZXMiOltd' +
    'LCJtYXBwaW5ncyI6IkFBQUEsTUFBTSxHQUFHLE9BQU8sSUFBSSxJQUFJLFFBQVEsQ0FBYSxvQkFBUSxDQUFDO0lBQUMsSU' +
    'FBSSxFQUFFLENBQU07QUFBQyxDQUFDIn2+aR5VAli0r5r6Lzs7wBZYhnIDMl4Vw9ngngQk0+Xtng==',
  v2_1_npm:
    'RVNaSVAyLjEAAACcAAAAD2ZpbGU6Ly8vbWFpbi50cwAAAAAAAAAAHQAAAAAAAACXAAAAAAxmaWxlOi8vL2IudHMAAAAAPQ' +
    'AAABYAAAC3AAAAiAAAAAAMZmlsZTovLy9hLnRzAQAAAAxmaWxlOi8vL2IudHMAAAAKcGFja2FnZUBeMQIAAAAAAAAADHBh' +
    'Y2thZ2VAXjEuMgIAAAAAAAAAA2RANQIAAAAENg96uN331mb1egxbAnUcIdzr1WAAN92vho2iaEw9RO8AAACPAAAADXBhY2' +
    'thZ2VAMS4yLjIAAAACAAAAAWEAAAABAAAAAWIAAAACAAAAB2FAMi4yLjMAAAABAAAAAWIAAAACAAAAB2JAMS4yLjMAAAAC' +
    'AAAAEnNvbWVvdGhlcnNwZWNpZmllcgAAAAMAAAABYQAAAAEAAAAHY0AxLjEuMQAAAAAAAAAHZEA1LjAuMAAAAACyeAcBW8' +
    'ZSEDBNj7O9ioRpL4pHEqhxcbWIq9hmG4EbVAAAAHNleHBvcnQgKiBhcyBhIGZyb20gIi4vYS50cyI7Ci8rIC513Okz6t+a' +
    'hXOqza39sx+u/7/1gJu4YVjQH4jSZXhwb3J0IGNvbnN0IGIgPSAiYiI7CsN9qIQMM/E+Hw1fyUHEUB5CC21YDY/q8fkABu' +
    'm/xBbEAAABX3sidmVyc2lvbiI6Mywic291cmNlcyI6WyJmaWxlOi8vL21haW4udHMiXSwic291cmNlc0NvbnRlbnQiOlsi' +
    'ZXhwb3J0ICogYXMgYSBmcm9tIFwiLi9hLnRzXCI7XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQU' +
    'FLLENBQUMsTUFBTSxTQUFTIn1PwoQ3tuDLYjnJmD5A9Yn/JK/EjKOFEs/3WqbSNNcEF3sidmVyc2lvbiI6Mywic291cmNl' +
    'cyI6WyJmaWxlOi8vL2IudHMiXSwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IGNvbnN0IGIgPSBcImJcIjtcbiJdLCJuYW' +
    '1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLE1BQU0sSUFBSSxJQUFJIn0aLCh22jZ5/VHD9vlEMNGkM67quWa7eBtH' +
    't7mbFEsVEw==',
  v2_3_wasm:
    'RVNaSVAyLjMAAAAEAAABAAAAAEwAAAAPZmlsZTovLy93YXNtLnRzAAAAAAAAAAA7AAAAAAAAANAAAAAAEWZpbGU6Ly8vbW' +
    'F0aC53YXNtAAAAADsAAAE+AAAAAAAAAAAEAAAAAAAAAXlpbXBvcnQgeyBhZGQgfSBmcm9tICIuL21hdGgud2FzbSI7CmNv' +
    'bnNvbGUubG9nKGFkZCgxLCAyKSk7CgBhc20BAAAAAQcBYAJ/fwF/AwMCAAAEBQFwAQEBBQMBABAGGQN/AUGAgMAAC38AQY' +
    'CAwAALfwBBgIDAAAsHNgUGbWVtb3J5AgADYWRkAAAIc3VidHJhY3QAAQpfX2RhdGFfZW5kAwELX19oZWFwX2Jhc2UDAgoR' +
    'AgcAIAEgAGoLBwAgACABawsANwRuYW1lAAoJbWF0aC53YXNtARACAANhZGQBCHN1YnRyYWN0BxIBAA9fX3N0YWNrX3BvaW' +
    '50ZXIATQlwcm9kdWNlcnMCCGxhbmd1YWdlAQRSdXN0AAxwcm9jZXNzZWQtYnkBBXJ1c3RjHTEuODAuMCAoMDUxNDc4OTU3' +
    'IDIwMjQtMDctMjEpACwPdGFyZ2V0X2ZlYXR1cmVzAisPbXV0YWJsZS1nbG9iYWxzKwhzaWduLWV4dAAAANB7InZlcnNpb2' +
    '4iOjMsInNvdXJjZXMiOlsiZmlsZTovLy93YXNtLnRzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGFkZCB9IGZy' +
    'b20gXCIuL21hdGgud2FzbVwiO1xuY29uc29sZS5sb2coYWRkKDEsIDIpKTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIj' +
    'oiQUFBQSxTQUFTLEdBQUcsUUFBUSxjQUFjO0FBQ2xDLFFBQVEsR0FBRyxDQUFDLElBQUksR0FBRyJ9',
};

describe('parseEszip on archives Deno itself wrote', () => {
  it('reads a v2.0 archive with a json module', () => {
    const modules = parseEszip(Buffer.from(REAL.v2_0, 'base64'));
    expect(modules.map(module => module.specifier)).toEqual(['file:///json.ts', 'file:///data.json']);
    expect(modules[0].source).toContain('from "./data.json"');
  });

  it('skips past a v2.1 npm snapshot to reach the sources', () => {
    const modules = parseEszip(Buffer.from(REAL.v2_1_npm, 'base64'));
    expect(modules.map(module => module.specifier)).toEqual(['file:///main.ts', 'file:///b.ts']);
    expect(modules.every(module => !module.source.includes('\u0000'))).toBe(true);
  });

  it('leaves a wasm module out: its "source" is binary, which is what NUL-bombs the insert', () => {
    const modules = parseEszip(Buffer.from(REAL.v2_3_wasm, 'base64'));
    expect(modules.map(module => module.specifier)).toEqual(['file:///wasm.ts']);
    expect(pickEntryModule(modules)?.specifier).toBe('file:///wasm.ts');
  });
});
