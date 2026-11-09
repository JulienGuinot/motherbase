'use strict';

// Writes the command table to docs/cli-commands.md. Run with `npm run docs:cli`.
// Guarded by test/docs.test.js, which fails when the committed file no longer
// matches the registry.

const fs = require('fs');
const path = require('path');
const { renderCommandDocs } = require('../src/docs');

const outPath = path.resolve(__dirname, '..', '..', '..', 'docs', 'cli-commands.md');
fs.writeFileSync(outPath, renderCommandDocs());
console.log(`✅ CLI command table written to ${outPath}`);
