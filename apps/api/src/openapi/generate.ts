import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from './openapi.js';

/** Writes docs/api/openapi.json (run after `nest build`: `pnpm --filter @1pos/api openapi`). */
const target = fileURLToPath(new URL('../../../../docs/api/openapi.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
console.log(`wrote ${target}`);
