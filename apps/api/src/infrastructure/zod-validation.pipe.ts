import { HttpStatus, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from './http-error.filter.js';

/** Validates and normalises a request part with a shared @1pos/validation schema. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  /** Public so the OpenAPI generator can describe the request from the same schema. */
  constructor(readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'Request validation failed', HttpStatus.BAD_REQUEST, {
        // code + bounds let clients show their own (translated) wording; message stays the fallback.
        issues: parsed.error.issues.map((i) => {
          const extra = i as { minimum?: unknown; maximum?: unknown; format?: unknown; origin?: unknown };
          return {
            path: i.path.join('.'),
            message: i.message,
            code: i.code,
            ...(extra.origin !== undefined && { origin: String(extra.origin) }),
            ...(extra.minimum !== undefined && { minimum: Number(extra.minimum) }),
            ...(extra.maximum !== undefined && { maximum: Number(extra.maximum) }),
            ...(extra.format !== undefined && { format: String(extra.format) }),
          };
        }),
      });
    }
    return parsed.data;
  }
}
