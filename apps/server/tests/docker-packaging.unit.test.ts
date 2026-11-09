import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

// The root workspace globs decide which packages/* directories exist. Any of
// them can be imported by the compiled server at runtime, so the Docker images
// have to (a) link every workspace during install and (b) ship every workspace
// in the runtime layer. Missing either one turns a workspace import into a
// MODULE_NOT_FOUND crash-loop that CI never sees, CI installs at the repo root
// where all manifests are already present.
const workspacePackages = fs
  .readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(path.join(repoRoot, 'packages', e.name, 'package.json')))
  .map(e => e.name);

describe('Docker packaging of workspace packages', () => {
  it('has at least the shared contracts package', () => {
    expect(workspacePackages).toContain('contracts');
  });

  it('deps image copies every workspace manifest before npm ci', () => {
    const deps = read('deploy/deps.Dockerfile');
    for (const name of workspacePackages) {
      expect(deps).toContain(`packages/${name}/package.json`);
    }
  });

  it('runtime image ships the built packages so workspace symlinks resolve', () => {
    const dockerfile = read('Dockerfile');
    // node_modules/@motherbase/* are symlinks into /app/packages/*; without the
    // real directories present the links dangle and require() throws.
    expect(dockerfile).toMatch(/COPY --from=build \/app\/packages \.\/packages/);
  });
});

describe('Docker packaging of the studio next build', () => {
  // The Studio is the Console's UI. A project API image carries no UI: it
  // builds only the server and its workspace dependencies.
  it('API image does not build or ship the studio', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/turbo run build --filter=@motherbase\/server\.\.\./);
    expect(dockerfile).not.toMatch(/^RUN npm run build$/m);
    expect(dockerfile).toMatch(/rm -rf apps\/studio/);
  });

  it('Console image builds the whole monorepo, studio included', () => {
    expect(read('apps/server/console/Dockerfile')).toMatch(/^RUN npm run build$/m);
  });

  it('deps image copies the studio manifest before npm ci', () => {
    expect(read('deploy/deps.Dockerfile')).toContain('apps/studio/package.json');
  });

  it('keeps next out of devDependencies, where a prune would delete it', () => {
    const manifest = JSON.parse(read('apps/studio/package.json'));
    expect(manifest.dependencies).toHaveProperty('next');
    expect(manifest.devDependencies ?? {}).not.toHaveProperty('next');
  });

  it('keeps the next config compiler-free so prepare() needs no typescript', () => {
    // The Console loads this config at runtime via nextApp.prepare(). With a .ts
    // config next shells out to `yarn add typescript` inside the read-only
    // container on every boot, blows the heap limit, and crash-loops behind an
    // opaque 502.
    expect(fs.existsSync(path.join(repoRoot, 'apps/studio/next.config.ts'))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, 'apps/studio/next.config.mjs'))).toBe(true);
  });
});
