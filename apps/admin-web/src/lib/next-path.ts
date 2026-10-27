// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f\\]/;
const PROBE = 'http://x.invalid';

/**
 * A path inside the admin, never another site: where to go after signing in (`?next=`, a handoff's
 * `next`, session 41). Browsers drop tabs and newlines from URLs (`/\t/evil.example` → `//evil.example`)
 * and read `\` as `/`, so any control character or backslash refuses it; it must start with one `/`
 * and resolve on this origin.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || UNSAFE.test(next)) return '/';
  try {
    return new URL(next, PROBE).origin === PROBE ? next : '/';
  } catch {
    return '/';
  }
}
