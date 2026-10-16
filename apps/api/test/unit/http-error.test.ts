import { describe, expect, it } from 'vitest';
import { isTransientDbError } from '../../src/infrastructure/http-error.filter.js';

const wrapped = (cause: object) => Object.assign(new Error('Failed query: select 1'), { cause });

describe('isTransientDbError (503 instead of 500)', () => {
  it.each([
    ['refused connection', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })],
    ['pool connect timeout', new Error('timeout exceeded when trying to connect')],
    ['backend killed (drizzle-wrapped)', wrapped({ code: '57P01', message: 'terminating connection due to administrator command' })],
    ['connection dropped', new Error('Connection terminated unexpectedly')],
    ['statement timeout', wrapped({ code: '57014' })],
    ['serialization failure', wrapped({ code: '40001' })],
    ['deadlock', wrapped({ code: '40P01' })],
    ['connection exception class 08', wrapped({ code: '08006' })],
  ])('%s', (_name, err) => expect(isTransientDbError(err)).toBe(true));

  it.each([
    ['unique violation', wrapped({ code: '23505' })],
    ['check violation', wrapped({ code: '23514' })],
    ['programming error', new TypeError('x is undefined')],
    ['nothing', undefined],
  ])('%s is not transient', (_name, err) => expect(isTransientDbError(err)).toBe(false));
});
