// Writes the controller route table to docs/admin-routes.md.
// Run with `npm run docs:routes`. Guarded by tests/route-manifest.unit.test.ts,
// which fails when the committed file no longer matches the decorators.
import fs from 'fs';
import path from 'path';
import { renderRouteDocs } from '../lib/route-docs';

const outPath = path.resolve(__dirname, '..', '..', '..', 'docs', 'admin-routes.md');
fs.writeFileSync(outPath, renderRouteDocs());
console.log(`✅ Route table written to ${outPath}`);
