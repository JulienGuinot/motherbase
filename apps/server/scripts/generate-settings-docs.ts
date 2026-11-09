// Writes the settings reference to docs/settings.md.
// Run with `npm run docs:settings`. Guarded by tests/settings-docs.unit.test.ts,
// which fails when the committed file no longer matches the registry.
import fs from 'fs';
import path from 'path';
import { renderSettingsDocs } from '../lib/settings-docs';

const outPath = path.resolve(__dirname, '..', '..', '..', 'docs', 'settings.md');
fs.writeFileSync(outPath, renderSettingsDocs());
console.log(`✅ Settings reference written to ${outPath}`);
