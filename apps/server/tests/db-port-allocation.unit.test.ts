import { describe, it, expect } from 'vitest';
import {
  DB_PORT_RANGE,
  allocateDbPort,
  parseDbPort,
  buildManifest,
  renderEnvProd,
  apiPortFor,
} from '../console/lib/manifest';
import { localApiUrl } from '../lib/local-api-url';

describe('apiPortFor', () => {
  // An API port inside the DB range would collide with another project's database.
  it('never lands in the DB port range', () => {
    expect(apiPortFor(DB_PORT_RANGE.first)).toBe(DB_PORT_RANGE.last + 1);
    expect(apiPortFor(DB_PORT_RANGE.last)).toBeGreaterThan(DB_PORT_RANGE.last);
  });
});

describe('localApiUrl', () => {
  it('is the loopback URL when API_PORT is set', () => {
    expect(localApiUrl('54421')).toBe('http://localhost:54421');
  });

  it('is null outside dev mode, where API_PORT is absent or empty', () => {
    expect(localApiUrl(undefined)).toBeNull();
    expect(localApiUrl('')).toBeNull();
    expect(localApiUrl('nope')).toBeNull();
  });
});

// Two projects sharing a host port means the second stack fails to bind, quietly
// and at a moment nobody is watching. These are the assertions that stops it.

describe('allocateDbPort', () => {
  it('starts at the bottom of the range', () => {
    expect(allocateDbPort([])).toBe(DB_PORT_RANGE.first);
  });

  it('never hands out a port another project already holds', () => {
    const taken = [DB_PORT_RANGE.first, DB_PORT_RANGE.first + 1];
    expect(allocateDbPort(taken)).toBe(DB_PORT_RANGE.first + 2);
  });

  it('fills a hole left by a deleted project rather than always growing', () => {
    const taken = [DB_PORT_RANGE.first, DB_PORT_RANGE.first + 2];
    expect(allocateDbPort(taken)).toBe(DB_PORT_RANGE.first + 1);
  });

  it('throws when the range is full instead of reusing a bound port', () => {
    const all: number[] = [];
    for (let p = DB_PORT_RANGE.first; p <= DB_PORT_RANGE.last; p++) all.push(p);
    expect(() => allocateDbPort(all)).toThrow(/no free database port/);
  });
});

describe('parseDbPort', () => {
  it('reads the port back out of an env file', () => {
    expect(parseDbPort('FOO=1\nDB_PORT=54321\nBAR=2\n')).toBe(54321);
  });

  it('returns undefined for a project that predates the field', () => {
    expect(parseDbPort('FOO=1\nBAR=2\n')).toBeUndefined();
  });

  it('refuses a malformed value rather than emitting NaN into a port mapping', () => {
    expect(parseDbPort('DB_PORT=\n')).toBeUndefined();
    expect(parseDbPort('DB_PORT=notaport\n')).toBeUndefined();
    expect(parseDbPort('DB_PORT=99999\n')).toBeUndefined();
  });
});

describe('renderEnvProd', () => {
  const base = { name: 'demo', domain: 'demo.example.com' };
  const gen = (n: number) => 'x'.repeat(n);

  it('emits DB_PORT and a loopback bind when a port was allocated', () => {
    const env = renderEnvProd(buildManifest({ ...base, dbPort: 54325 }, gen));
    expect(env).toContain('DB_PORT=54325');
    // Loopback by default: publishing Postgres to the internet has to be a
    // decision an operator takes, never one they inherit.
    expect(env).toContain('DB_BIND=127.0.0.1');
  });

  it('emits neither when no port was allocated', () => {
    const env = renderEnvProd(buildManifest(base, gen));
    expect(env).not.toContain('DB_PORT=');
    expect(env).not.toContain('DB_BIND=');
  });

  it('emits the API port derived from the DB port, and none without one', () => {
    expect(renderEnvProd(buildManifest({ ...base, dbPort: 54325 }, gen))).toContain('API_PORT=54425');
    expect(renderEnvProd(buildManifest(base, gen))).not.toContain('API_PORT=');
  });

  it('round-trips through parseDbPort', () => {
    const env = renderEnvProd(buildManifest({ ...base, dbPort: 54399 }, gen));
    expect(parseDbPort(env)).toBe(54399);
  });
});
