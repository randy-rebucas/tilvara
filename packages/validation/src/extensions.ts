/**
 * Extensions (ADR-0026): industry modules built on the retail base (pharmacy, …), switched on per
 * business by its owner when the plan allows them. Every business has the base; an extension only adds.
 * How to add one: docs/architecture/extensions.md.
 *
 * Only type imports from ./permissions.js: that module reads EXTENSIONS at load time.
 */
import { z } from 'zod';
import type { PermissionCode } from './permissions.js';

/** An extension's code as a route parameter (`extensions.code` has the same format check). */
export const extensionCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'Unknown extension');

/** A built-in role an extension adds when a business switches it on (seeded additively, like ROLE_TEMPLATES). */
export interface ExtensionRoleTemplate {
  key: string;
  name: string;
  /** Base codes, this extension's codes and the codes of the extensions it requires. */
  permissions: readonly string[];
}

export interface ExtensionManifest {
  /** Matches `extensions.code` (its migration inserts the row): lower case, digits and underscores. */
  code: string;
  /** Extensions that must be on first (and stay on while this one is). */
  requires?: readonly string[];
  /** Permission codes it adds, `<code>.<action>`; its migration seeds them into `permissions`. */
  permissions: readonly string[];
  /** Which of its codes make a member privileged (two-step sign-in, ADR-0016). */
  privileged?: readonly string[];
  /** Which of its codes a support session may use (read codes only). */
  support?: readonly string[];
  roleTemplates?: readonly ExtensionRoleTemplate[];
}

/** The extensions this build knows. None yet: pharmacy is the first planned (docs/INDUSTRIES.md). */
export const EXTENSIONS = [] as const satisfies readonly ExtensionManifest[];

// Generic so they distribute over the union (and give `never` while EXTENSIONS is empty).
type CodeOf<M> = M extends { code: infer C extends string } ? C : never;
type PermissionOf<M> = M extends { permissions: readonly (infer P extends string)[] } ? P : never;
export type ExtensionCode = CodeOf<(typeof EXTENSIONS)[number]>;
export type ExtensionPermission = PermissionOf<(typeof EXTENSIONS)[number]>;

const manifests: readonly ExtensionManifest[] = EXTENSIONS;

export const extensionManifest = (code: string, list: readonly ExtensionManifest[] = manifests): ExtensionManifest | undefined =>
  list.find((m) => m.code === code);

/** Whether `code` is among the business's usable extensions (`/me` → `activeTenant.extensions`). */
export const extensionOn = (usable: readonly string[] | undefined, code: string): boolean => (usable ?? []).includes(code);

/** The extensions `manifest` requires that are not on. */
export const missingRequirements = (manifest: ExtensionManifest, enabled: readonly string[]): string[] =>
  (manifest.requires ?? []).filter((r) => !enabled.includes(r));

/** The extensions that are on and require `code` (so `code` cannot be switched off). */
export const dependentsOf = (code: string, enabled: readonly string[], list: readonly ExtensionManifest[] = manifests): string[] =>
  list.filter((m) => enabled.includes(m.code) && (m.requires ?? []).includes(code)).map((m) => m.code);

/** Every permission code the extensions add. */
export const extensionPermissions = (list: readonly ExtensionManifest[] = manifests): PermissionCode[] =>
  list.flatMap((m) => m.permissions) as PermissionCode[];

export const extensionPrivileged = (list: readonly ExtensionManifest[] = manifests): PermissionCode[] =>
  list.flatMap((m) => m.privileged ?? []) as PermissionCode[];

export const extensionSupport = (list: readonly ExtensionManifest[] = manifests): PermissionCode[] =>
  list.flatMap((m) => m.support ?? []) as PermissionCode[];
