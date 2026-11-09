import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { controller } from 'awilix-express';
import AdminAuthController from '../controllers/admin/admin-auth.controller';
import AdminContentController from '../controllers/admin/admin-content.controller';
import AdminCoreController from '../controllers/admin/admin-core.controller';
import AdminDbController from '../controllers/admin/admin-db.controller';
import AdminDatabaseController from '../controllers/admin/admin-database.controller';
import AdminGitController from '../controllers/admin/admin-git.controller';
import AdminInfrastructureController from '../controllers/admin/admin-infrastructure.controller';
import AdminObservabilityController from '../controllers/admin/admin-observability.controller';
import AdminOperationsController from '../controllers/admin/admin-operations.controller';
import AdminQueuesController from '../controllers/admin/admin-queues.controller';
import AdminWrappersController from '../controllers/admin/admin-wrappers.controller';
import AdminVaultController from '../controllers/admin/admin-vault.controller';
import AdminRowsController from '../controllers/admin/admin-rows.controller';
import AdminSchemaController from '../controllers/admin/admin-schema.controller';
import AdminSecurityController from '../controllers/admin/admin-security.controller';
import AdminSettingsController from '../controllers/admin/admin-settings.controller';
import AdminStorageController from '../controllers/admin/admin-storage.controller';
import AdminStorageS3Controller from '../controllers/admin/admin-storage-s3.controller';
import AdminUsersController from '../controllers/admin/admin-users.controller';
import manifest from './fixtures/admin-route-manifest.json';

type RouteMetadata = {
  method: string;
  path: string;
  guard: string;
  handler: string;
};

const routePattern =
  /@(GET|POST|PATCH|PUT|DELETE)\(\)\r?\n {2}@route\(\x27([^\x27]+)\x27\)\r?\n {2}@before\((adminOnly|adminUpload|adminBackupUpload|\[apiKeyMiddleware, secretKeyOrAdmin\])\)\r?\n {2}async (\w+)\(/g;
const metadataKey = ({ method, path: routePath, guard, handler }: RouteMetadata) =>
  [method, routePath, guard, handler].join(' ');

function currentAdminRoutes(): RouteMetadata[] {
  const controllerDirectory = path.resolve(__dirname, '../controllers/admin');
  const controllerFiles = fs.readdirSync(controllerDirectory).filter(file => /^admin-.+\.controller\.ts$/.test(file));

  return controllerFiles.flatMap(file => {
    const source = fs.readFileSync(path.join(controllerDirectory, file), 'utf8');
    expect(source, file).toContain('@route(\x27/api/admin\x27)');
    // `adminOnly` stays the import every admin controller shares; a controller
    // may also pull in `secretKeyOrAdmin`, the one documented exception (see
    // platform-admin.middleware), but nothing else may guard an admin route.
    expect(source, file).toMatch(
      /import \{ adminOnly(?:, secretKeyOrAdmin)? \} from '\.\.\/\.\.\/middlewares\/platform-admin\.middleware';/
    );
    if (source.includes('@before(adminUpload)')) {
      expect(source, file).toContain('const adminUpload = [...adminOnly, streamUpload.single(\x27file\x27)];');
    }
    // The one other multipart guard. It exists because a backup file is
    // routinely far larger than MAX_UPLOAD_MB, and pinning its definition here
    // is what stops that bigger ceiling from quietly spreading to another route.
    if (source.includes('@before(adminBackupUpload)')) {
      expect(source, file).toContain('const adminBackupUpload = [...adminOnly, backupUpload.single(\x27file\x27)];');
    }
    return [...source.matchAll(routePattern)].map(match => ({
      method: match[1],
      path: match[2],
      guard: match[3],
      handler: match[4],
    }));
  });
}

describe('admin route contract', () => {
  it('preserves the exact method, path, guard and handler manifest', () => {
    const expected = (manifest as RouteMetadata[]).map(metadataKey).sort();
    const current = currentAdminRoutes().map(metadataKey).sort();

    expect(current).toEqual(expected);
  });

  it('registers every domain controller on the shared prefix', () => {
    const router = controller([
      AdminAuthController,
      AdminContentController,
      AdminCoreController,
      AdminDbController,
      AdminDatabaseController,
      AdminGitController,
      AdminInfrastructureController,
      AdminObservabilityController,
      AdminOperationsController,
      AdminQueuesController,
      AdminWrappersController,
      AdminVaultController,
      AdminRowsController,
      AdminSchemaController,
      AdminSecurityController,
      AdminSettingsController,
      AdminStorageController,
      AdminStorageS3Controller,
      AdminUsersController,
    ]) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    };
    const registered = router.stack.flatMap(layer =>
      layer.route
        ? Object.keys(layer.route.methods).map(method => [method.toUpperCase(), layer.route!.path].join(' '))
        : []
    );
    const expected = (manifest as RouteMetadata[])
      .map(route => [route.method, '/api/admin' + route.path].join(' '))
      .sort();

    expect(registered.sort()).toEqual(expected);
  });

  it('does not register a method and path more than once', () => {
    const routes = currentAdminRoutes();
    const methodPaths = routes.map(route => [route.method, route.path].join(' '));

    expect(new Set(methodPaths).size).toBe(methodPaths.length);
  });

  it('delegates caught errors to the global error middleware', async () => {
    const failure = new Error('database unavailable');
    const execute = vi.fn().mockRejectedValue(failure);
    const next = vi.fn();
    const admin = new AdminCoreController({ SqlService: { execute } } as never);

    const result = await admin.sql({ body: { sql: 'SELECT 1' } } as never, {} as never, next);

    expect(result).toBeUndefined();
    expect(execute).toHaveBeenCalledWith('SELECT 1');
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(failure);
  });

  it('forbids controller-local error serialization', () => {
    const controllerDirectory = path.resolve(__dirname, '../controllers/admin');
    const controllerFiles = fs.readdirSync(controllerDirectory).filter(file => /^admin-.+\.controller\.ts$/.test(file));

    for (const file of controllerFiles) {
      const source = fs.readFileSync(path.join(controllerDirectory, file), 'utf8');
      const catches = source.match(/catch \(error: unknown\)/g) ?? [];
      const delegations = source.match(/return next\(error\);/g) ?? [];

      expect(source, file).not.toMatch(/\bErrorResponse\b|\bfail\s*\(/);
      expect(catches.length, file).toBeGreaterThan(0);
      expect(delegations.length, file).toBe(catches.length);
    }
  });
});
