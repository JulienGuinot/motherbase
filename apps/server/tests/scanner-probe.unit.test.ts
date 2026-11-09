import { describe, expect, it } from 'vitest';
import { isScannerProbe } from '../middlewares/scanner-probe';

describe('isScannerProbe', () => {
  it.each([
    ['GET', '/.env'],
    ['GET', '/.env.production'],
    ['GET', '/.git/config'],
    ['GET', '/.aws/credentials'],
    ['GET', '/wp-login.php'],
    ['GET', '/wp-admin/setup-config.php'],
    ['GET', '/phpmyadmin/index.php'],
    ['GET', '/xmlrpc.php'],
    ['POST', '/'],
    ['PUT', '/'],
  ])('turns away %s %s', (method, path) => {
    expect(isScannerProbe(method, path)).toBe(true);
  });

  it.each([
    ['GET', '/'],
    ['HEAD', '/'],
    ['OPTIONS', '/'],
    ['GET', '/api/health-check'],
    ['GET', '/auth/v1/.well-known/jwks.json'],
    ['GET', '/.well-known/openid-configuration'],
    // A storage key is the operator's to name, dotfiles and .php included.
    ['GET', '/storage/v1/object/public/assets/.env'],
    ['GET', '/storage/v1/object/public/assets/index.php'],
    ['POST', '/rest/v1/orders'],
  ])('lets %s %s through', (method, path) => {
    expect(isScannerProbe(method, path)).toBe(false);
  });
});
