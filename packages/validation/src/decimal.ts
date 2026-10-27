/**
 * Sign checks on decimal strings a schema has already validated as unsigned (`"0.0500"`, `"12"`),
 * without JS numbers (audit 45 #37). This package has no `@1pos/money` dependency; comparing digits is
 * exact for the plain unsigned forms the regexes allow. Callers pass only regex-checked strings.
 */
export const isPositiveDecimal = (value: string | undefined | null): boolean => !!value && /[1-9]/.test(value);
