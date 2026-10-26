import type { MessageKey } from '../i18n';
import type { GuideTopic } from './guide';

export type Tab = 'sell' | 'history' | 'close';

export interface TabDef {
  key: Tab;
  label: MessageKey;
  /** The part of the user guide the tab opens. */
  topic: GuideTopic;
  /** The extension this tab belongs to (ADR-0026): shown only while the business has it. */
  extension?: string;
}

/** The counter's tabs, in order. An extension's screen adds its tab here with `extension`. */
export const TABS: readonly TabDef[] = [
  { key: 'sell', label: 'nav.sell', topic: 'sell' },
  { key: 'history', label: 'nav.history', topic: 'shift' },
  { key: 'close', label: 'nav.close', topic: 'close' },
];

/** The tabs for a business with these extensions on (`/me` → `activeTenant.extensions`). */
export const tabsFor = (extensions: readonly string[]) => TABS.filter((tab) => !tab.extension || extensions.includes(tab.extension));
