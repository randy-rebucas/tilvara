import { HttpStatus, PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { AppError } from './http-error.filter.js';

/** Validates and normalises a request part with a shared @1pos/validation schema. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', 'Request validation failed', HttpStatus.BAD_REQUEST, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return parsed.data;
  }
}
