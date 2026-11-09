import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// A Console project's API container sees only what its Compose file's explicit
// `environment` block names: the project's .env.prod is read for interpolation,
// never passed through. Three server settings were missing, so on every Console
// project the edge token could not be set, public invocation could not be
// switched on, and uploads were stuck at 25 MB, whatever .env.prod said. Signed
// storage URLs were signed for MinIO's container address.

const REPO = path.resolve(__dirname, '../../..');
const FILES = ['deploy/docker-compose.prod.yml', 'deploy/docker-compose.dev-multi.yml'];

function apiEnv(file: string): Record<string, string> {
  const doc = yaml.load(readFileSync(path.join(REPO, file), 'utf8')) as { services: Record<string, any> };
  return doc.services.api.environment;
}

describe.each(FILES)('%s api environment', file => {
  it.each(['EDGE_INVOKE_TOKEN', 'EDGE_PUBLIC_INVOKE_ENABLED', 'MAX_UPLOAD_MB'])('forwards %s from the project env', name => {
    expect(String(apiEnv(file)[name])).toContain(`\${${name}:-`);
  });

  it('keeps the safe defaults when .env.prod says nothing', () => {
    const env = apiEnv(file);
    expect(env.EDGE_PUBLIC_INVOKE_ENABLED).toBe('${EDGE_PUBLIC_INVOKE_ENABLED:-false}');
    expect(env.MAX_UPLOAD_MB).toBe('${MAX_UPLOAD_MB:-25}');
  });

  it('signs storage URLs for the public storage domain, not http://minio:9000', () => {
    const env = apiEnv(file);
    expect(env.S3_ENDPOINT).toBe('http://minio:9000');
    expect(env.S3_PRESIGN_ENDPOINT).toMatch(/^https?:\/\/\$\{STORAGE_DOMAIN\}$/);
  });
});
