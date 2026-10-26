import type { Database } from '@1pos/database';
import { EXTENSIONS, type ExtensionManifest } from '@1pos/validation';
import type { AuthContext } from '../auth/auth-context.js';

/** What the server adds to an extension's manifest (ADR-0026). */
export interface ServerExtension extends ExtensionManifest {
  /** Runs when the business switches it on, in the same transaction: seed its defaults (idempotent; it runs again after a switch off and on). */
  onEnable?(db: Database, auth: AuthContext): Promise<void>;
  /** Open records that must be finished before it is switched off (e.g. open job orders); none = it may be. */
  disableBlockers?(db: Database): Promise<{ code: string; count: number }[]>;
}

/** The extensions the API serves; integration tests replace the provider with fixtures. */
export const EXTENSION_MANIFESTS = Symbol('EXTENSION_MANIFESTS');

/** Server hooks by extension code, merged into the shared manifests. None yet. */
const SERVER_HOOKS: Record<string, Pick<ServerExtension, 'onEnable' | 'disableBlockers'>> = {};

export const SERVER_EXTENSIONS: readonly ServerExtension[] = (EXTENSIONS as readonly ExtensionManifest[]).map((m) => ({ ...m, ...SERVER_HOOKS[m.code] }));
