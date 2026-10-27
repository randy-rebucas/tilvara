import { en, type MessageKey } from '../i18n/messages';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

const has = (key: string): key is MessageKey => key in en;

/** A detail's name in words (`audit.key.<key>`); a key this build has no words for is shown as stored. */
const keyName = (t: T, k: string) => (has(`audit.key.${k}`) ? t(`audit.key.${k}` as MessageKey) : k);

/** A changed field in words (`audit.field.<field>`); the removed trades' fields keep their code (history). */
const fieldName = (t: T, f: string) => (has(`audit.field.${f}`) ? t(`audit.field.${f}` as MessageKey) : f);

function value(t: T, k: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return t(v ? 'audit.yes' : 'audit.no');
  if (Array.isArray(v)) {
    // Field names only, never values (ADR-0018): which details changed, in words.
    if (k === 'fields' && v.every((f) => typeof f === 'string')) return v.map((f) => fieldName(t, f)).join(', ');
    return t('audit.items', { n: v.length });
  }
  if (typeof v === 'object') return '…';
  // How a customer's consent was given (customer_consent_events.source).
  if (k === 'source' && has(`cust.source.${String(v)}`)) return t(`cust.source.${String(v)}` as MessageKey);
  return String(v);
}

/** A short, readable view of an audit event's details: the first six, named in words where the app knows them. */
export function auditDetails(t: T, m: Record<string, unknown>): string {
  return Object.entries(m)
    .slice(0, 6)
    .map(([k, v]) => `${keyName(t, k)}: ${value(t, k, v)}`)
    .join(' · ');
}
