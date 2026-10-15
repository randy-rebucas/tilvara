import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenApi } from '../../src/openapi/openapi.js';

type Op = { requestBody?: unknown; parameters?: { in: string; name: string }[]; security?: unknown[]; responses: Record<string, unknown> };
const spec = buildOpenApi() as { paths: Record<string, Record<string, Op>> };
const op = (path: string, verb: string) => spec.paths[path]![verb]!;

describe('OpenAPI document', () => {
  it('matches the committed docs/api/openapi.json (run `pnpm --filter @1pos/api openapi` after route changes)', () => {
    const committed = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/api/openapi.json', import.meta.url)), 'utf8'));
    expect(JSON.parse(JSON.stringify(spec))).toEqual(committed);
  });

  it('describes request bodies, queries, path ids and idempotency from route metadata', () => {
    expect(Object.keys(spec.paths).length).toBeGreaterThan(40);
    expect(op('/v1/products', 'post').requestBody).toBeDefined();
    expect(op('/v1/products', 'get').parameters?.map((p) => p.name)).toEqual(expect.arrayContaining(['q', 'cursor']));
    expect(op('/v1/products/{id}', 'patch').parameters).toContainEqual(expect.objectContaining({ in: 'path', name: 'id' }));
    expect(op('/v1/products', 'post').parameters).toContainEqual(expect.objectContaining({ in: 'header', name: 'Idempotency-Key' }));
    expect(op('/v1/auth/login', 'post').security).toEqual([]);
    expect(op('/v1/auth/login', 'post').responses['429']).toBeDefined();
    expect(op('/v1/members', 'get').security).toBeUndefined();
  });
});
