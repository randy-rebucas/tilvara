import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { z, type ZodType } from 'zod';
import { AppModule } from '../app.module.js';
import { IS_PUBLIC, REQUIRED_PERMISSIONS, REQUIRES_TENANT } from '../auth/auth-context.js';
import { IDEMPOTENT, type IdempotentOptions } from '../infrastructure/idempotency.js';
import { RATE_LIMIT, type RateLimitRule } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';

/**
 * OpenAPI 3.1 document derived from the same metadata Nest routes with: controller/method
 * paths, the ZodPipe schemas on @Body/@Query (z.toJSONSchema), and the 1POS route decorators.
 * Response bodies are not schema-typed yet (services return Drizzle rows); every operation
 * documents the shared error envelope instead. Regenerate with `pnpm --filter @1pos/api openapi`.
 */
type Json = Record<string, unknown>;
type Ctor = abstract new (...args: never[]) => unknown;

const GLOBAL_PREFIX = '/v1';

function controllersOf(module: unknown, seen = new Set<unknown>()): Ctor[] {
  if (!module || seen.has(module)) return [];
  seen.add(module);
  const own = (Reflect.getMetadata('controllers', module as object) ?? []) as Ctor[];
  const imports = (Reflect.getMetadata('imports', module as object) ?? []) as unknown[];
  return [...own, ...imports.flatMap((m) => controllersOf(m, seen))];
}

const joinPath = (...parts: string[]) =>
  '/' + parts.flatMap((p) => p.split('/')).filter(Boolean).join('/');

function jsonSchema(schema: ZodType): Json {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  return rest;
}

interface RouteArg {
  index: number;
  data?: string;
  pipes?: unknown[];
}

function zodOf(arg: RouteArg | undefined): ZodType | undefined {
  return (arg?.pipes ?? []).find((p): p is ZodPipe<unknown> => p instanceof ZodPipe)?.schema;
}

const errorEnvelope: Json = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: 'Stable machine-readable code, e.g. NOT_FOUND, VALIDATION_FAILED, CODE_TAKEN' },
        message: { type: 'string' },
        details: { type: 'object' },
        correlationId: { type: 'string' },
      },
    },
  },
};

export function buildOpenApi(version = '0.1.0'): Json {
  const paths: Record<string, Record<string, Json>> = {};

  for (const ctrl of controllersOf(AppModule)) {
    const base = (Reflect.getMetadata(PATH_METADATA, ctrl) as string | undefined) ?? '/';
    const tag = ctrl.name.replace(/Controller$/, '').toLowerCase();
    const proto = ctrl.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = proto[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const sub = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (sub === undefined || method === undefined) continue;

      const verb = RequestMethod[method].toLowerCase();
      const nestPath = joinPath(GLOBAL_PREFIX, base, sub);
      const path = nestPath.replace(/:(\w+)/g, '{$1}');
      const meta = <T>(key: string) => (Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, ctrl)) as T | undefined;
      const isPublic = meta<boolean>(IS_PUBLIC) === true;
      const perms = meta<string[]>(REQUIRED_PERMISSIONS);
      const needsTenant = meta<boolean>(REQUIRES_TENANT) === true || (perms?.length ?? 0) > 0;
      const idempotent = meta<IdempotentOptions>(IDEMPOTENT);
      const rateLimit = meta<RateLimitRule>(RATE_LIMIT);
      const status = (Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ?? (verb === 'post' ? 201 : 200);

      const args = Object.entries((Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, name) ?? {}) as Record<string, RouteArg>);
      const argOf = (type: RouteParamtypes) => args.find(([k]) => k.split(':')[0] === String(type))?.[1];

      const parameters: Json[] = [...nestPath.matchAll(/:(\w+)/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      }));
      const query = zodOf(argOf(RouteParamtypes.QUERY));
      if (query) {
        const qs = jsonSchema(query) as { properties?: Record<string, Json>; required?: string[] };
        for (const [qName, qSchema] of Object.entries(qs.properties ?? {})) {
          parameters.push({ name: qName, in: 'query', required: qs.required?.includes(qName) ?? false, schema: qSchema });
        }
      }
      if (idempotent) {
        parameters.push({
          name: 'Idempotency-Key',
          in: 'header',
          required: idempotent.required === true,
          description: 'UUID; a retry with the same key and body replays the stored response (header Idempotent-Replayed).',
          schema: { type: 'string', format: 'uuid' },
        });
      }

      const body = zodOf(argOf(RouteParamtypes.BODY));
      const descriptionLines = [
        needsTenant ? 'Requires an active tenant on the access token.' : null,
        perms?.length ? `Tenant-scope permissions: ${perms.join(', ')}.` : null,
        !isPublic && !perms?.length ? 'Fine-grained permission (incl. branch/register scope) is checked in the service.' : null,
        rateLimit ? `Rate limit: ${rateLimit.limit} per ${rateLimit.windowSeconds}s per IP (bucket ${rateLimit.bucket}).` : null,
      ].filter(Boolean);

      const errors: Record<string, Json> = {};
      const errorRef = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
      if (body || query || parameters.some((p) => p.in === 'path')) errors['400'] = errorRef('Validation failed');
      if (!isPublic) {
        errors['401'] = errorRef('Missing, expired or revoked access token');
        errors['403'] = errorRef('Not permitted (or no active tenant)');
      }
      if (parameters.some((p) => p.in === 'path')) errors['404'] = errorRef("Not found in the caller's tenant (other tenants' ids also 404)");
      if (verb !== 'get' && !isPublic) {
        errors['402'] = errorRef('Subscription is read-only (lapsed trial, past due after grace, or canceled)');
        errors['409'] = errorRef('Conflict (stable code in error.code)');
      }
      if (idempotent) errors['422'] = errorRef('Idempotency-Key reused with a different payload or user');
      if (rateLimit) errors['429'] = errorRef('Rate limited (Retry-After header)');

      const op: Json = {
        operationId: `${tag}.${name}`,
        tags: [tag],
        ...(descriptionLines.length ? { description: descriptionLines.join(' ') } : {}),
        ...(isPublic ? { security: [] } : {}),
        ...(parameters.length ? { parameters } : {}),
        ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(body) } } } } : {}),
        responses: { [String(status)]: { description: 'Success' }, ...errors },
        ...(perms?.length ? { 'x-required-permissions': perms } : {}),
      };
      (paths[path] ??= {})[verb] = op;
    }
  }

  const sorted = Object.fromEntries(Object.keys(paths).sort().map((p) => [p, paths[p]]));
  return {
    openapi: '3.1.0',
    info: {
      title: '1POS API',
      version,
      description:
        'Multi-tenant retail + restaurant POS API. Generated from route metadata and @1pos/validation schemas; ' +
        'money and quantities are decimal strings. See docs/api/CONVENTIONS.md.',
    },
    servers: [{ url: 'http://127.0.0.1:4320', description: 'Local development' }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: { Error: errorEnvelope },
    },
    paths: sorted,
  };
}
