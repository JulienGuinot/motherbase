import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { generateSecret, parseArgs, defaultAnswers, buildEnvFile, parseDbHostPort } from '../scripts/setup.lib';

const setupScript = fs.readFileSync(path.resolve(__dirname, '../../../setup.sh'), 'utf8');

describe('generateSecret', () => {
  it('produces a long hex string by default', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[0-9a-f]+$/);
    expect(s.length).toBeGreaterThanOrEqual(64);
  });

  it('produces a different value each call', () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe('parseDbHostPort', () => {
  it('reads host and explicit port from a connection string', () => {
    expect(parseDbHostPort('postgresql://user:pw@db.example.com:55432/app?schema=public')).toEqual({
      host: 'db.example.com',
      port: 55432,
    });
  });

  it('defaults the port to 5432 when omitted', () => {
    expect(parseDbHostPort('postgresql://postgres@localhost/app')).toEqual({ host: 'localhost', port: 5432 });
  });

  it('falls back to localhost:5432 for an unparseable URL', () => {
    expect(parseDbHostPort('not-a-url')).toEqual({ host: 'localhost', port: 5432 });
  });
});

describe('parseArgs', () => {
  it('detects --yes / -y', () => {
    expect(parseArgs(['--yes']).yes).toBe(true);
    expect(parseArgs(['-y']).yes).toBe(true);
    expect(parseArgs([]).yes).toBe(false);
  });

  it('detects --help / -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs([]).help).toBe(false);
  });
});

describe('defaultAnswers', () => {
  const a = defaultAnswers();

  it('targets a local postgres matching docker-compose', () => {
    expect(a.databaseUrl).toContain('localhost:5432');
    expect(a.databaseUrl).toContain('/app');
  });

  it('defaults storage to local and enables the Console SQL editor for dev', () => {
    expect(a.storageDriver).toBe('local');
    expect(a.consoleSqlEnabled).toBe(true);
  });

  it('always carries freshly generated secrets (never a shared admin default)', () => {
    expect(a.jwtSecret.length).toBeGreaterThanOrEqual(64);
    expect(a.jwtSecret).not.toContain('change-me');
    expect(a.seedAdminPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(a.seedAdminPassword).not.toBe(defaultAnswers().seedAdminPassword);
  });

  it('generates a 32-byte base64 config encryption key', () => {
    expect(Buffer.from(a.configEncryptionKey, 'base64').length).toBe(32);
  });
});

describe('supported setup password security', () => {
  it('generates a strong password and never uses the historical shared default', () => {
    expect(setupScript).toContain('ADMIN_PASSWORD="Mb-$(gen_hex24)"');
    expect(setupScript).not.toMatch(/ADMIN_PASSWORD=.*admin12345/);
  });

  it('validates password length and prints a generated password only once', () => {
    expect(setupScript).toContain('[ "${#ADMIN_PASSWORD}" -ge "$min_length" ]');
    expect(setupScript.match(/Generated admin password \(shown once\)/g)).toHaveLength(1);
    expect(setupScript).not.toContain('($ADMIN_EMAIL / $ADMIN_PASSWORD)');
    expect(setupScript).toContain(
      'CONSOLE_ADMIN_PASSWORD_TEMPORARY=$([ "$ADMIN_PASSWORD_GENERATED" = "1" ] && printf true || printf false)',
    );
    expect(setupScript).toContain('set_env_file "$envf" CONSOLE_ADMIN_PASSWORD_TEMPORARY false');
  });
});

describe('buildEnvFile', () => {
  const env = buildEnvFile({
    ...defaultAnswers(),
    jwtSecret: 'deadbeef',
    port: 5001,
  });

  it('emits the required keys', () => {
    for (const key of ['DATABASE_URL', 'JWT_SECRET', 'CONFIG_ENCRYPTION_KEY', 'PORT', 'STORAGE_DRIVER', 'CONSOLE_SQL_ENABLED']) {
      expect(env).toContain(`${key}=`);
    }
  });

  it('writes the provided secret and no placeholder', () => {
    expect(env).toContain('JWT_SECRET=deadbeef');
    expect(env).not.toContain('change-me');
  });

  it('produces only KEY=VALUE lines or comments/blanks', () => {
    for (const line of env.split('\n')) {
      if (line.trim() === '' || line.startsWith('#')) continue;
      expect(line).toMatch(/^[A-Z0-9_]+=.*$/);
    }
  });
});

describe('production image and orchestration hardening', () => {
  it('resolves external runtime images to RepoDigests in VPS mode', () => {
    expect(setupScript).toContain('resolve_external_digest()');
    expect(setupScript).toContain('docker image inspect "$ref" --format \'{{index .RepoDigests 0}}\'');
    expect(setupScript).toContain('*@sha256:*');
    expect(setupScript).toContain('pin_vps_external_images');
  });

  it('generates the internal bearer and builds Docker tooling only into the daemon image', () => {
    expect(setupScript).toContain('ORCHESTRATION_SECRET=${orchestration_secret}');
    expect(setupScript).toContain('set_env_file "$envf" ORCHESTRATION_SECRET "$(gen_hex)"');
    expect(setupScript).toContain('-f apps/server/console/Orchestration.Dockerfile');
    expect(setupScript).toContain('--build-arg DOCKER_CLI_IMAGE="$DOCKER_CLI_IMAGE"');
    expect(setupScript).toContain('docker run --rm --entrypoint docker "$ORCHESTRATION_IMAGE" compose version');
    expect(setupScript).not.toContain('entrypoint docker "$CONSOLE_IMAGE" compose version');
  });

  it('builds the PostgreSQL runtime image during setup', () => {
    expect(setupScript).toContain('docker build -t "$POSTGRES_IMAGE" -f deploy/postgres.Dockerfile .');
  });
});
