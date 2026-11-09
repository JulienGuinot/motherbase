// Writes the OpenAPI spec to openapi.json. Run with `npm run swagger`.
import fs from 'fs';
import path from 'path';
import { openapiSpec } from './config/openapi';

const outPath = path.resolve(__dirname, 'openapi.json');
fs.writeFileSync(outPath, JSON.stringify(openapiSpec, null, 2));
console.log(`✅ OpenAPI spec written to ${outPath}`);
