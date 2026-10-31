import { en, type MessageKey } from '../i18n/messages';
import { formatDateTime } from './format';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;
type Lang = 'en' | 'fil';

const has = (key: string): key is MessageKey => key in en;

/** The words for `<prefix><value>` when the app has them, else the value as stored. */
const word = (t: T, prefix: string, v: string) => (has(`${prefix}${v}`) ? t(`${prefix}${v}` as MessageKey) : v);

/** A detail's name in words (`audit.key.<key>`); a key this build has no words for is shown as stored. */
const keyName = (t: T, k: string) => word(t, 'audit.key.', k);

/** A changed field in words (`audit.field.<field>`); the removed trades' fields keep their code (history). */
const fieldName = (t: T, f: string) => word(t, 'audit.field.', f);

/** Details holding a moment (billing, subscription, data export rows): shown as a date and time in Manila. */
const DATE_KEYS = new Set(['periodEnd', 'graceEndsAt', 'trialEndsAt', 'expiresAt']);

/** Who did it on billing rows: the hourly pass, Tilvara support, the owner, the payment provider (`audit.who.<value>`). */
const WHO_KEYS = new Set(['actor', 'by', 'provider']);

function bytes(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function value(t: T, lang: Lang, k: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return t(v ? 'audit.yes' : 'audit.no');
  if (Array.isArray(v)) {
    // Field names only, never values (ADR-0018): which details changed, in words.
    if (k === 'fields' && v.every((f) => typeof f === 'string')) return v.map((f) => fieldName(t, f)).join(', ');
    return t('audit.items', { n: v.length });
  }
  if (typeof v === 'object') return '…';
  const s = String(v);
  // Rows written before audit 2026-10-31 name ops' login (`ops:<login>`, also inside a void's reason): the business sees only "Tilvara support".
  if (s.startsWith('ops:')) return t('audit.who.support');
  // How a customer's consent was given (customer_consent_events.source).
  if (k === 'source') return word(t, 'cust.source.', s);
  if (k === 'status' || k === 'fromStatus') return word(t, 'status.', s);
  if (k === 'plan' || k === 'fromPlan' || k === 'scheduledPlan') return word(t, 'audit.plan.', s);
  if (k === 'limit') return word(t, 'sub.', s);
  if (k === 'billStatus') return word(t, 'audit.billStatus.', s);
  if (k === 'effect') return word(t, 'audit.effect.', s);
  if (k === 'kind') return word(t, 'audit.billKind.', s);
  if (k === 'method') {
    for (const prefix of ['ap.method.', 'tender.', 'rcpt.method.']) if (has(`${prefix}${s}`)) return t(`${prefix}${s}` as MessageKey);
    return s;
  }
  // The hourly pass and support write a code (`PAID_UNTIL_REACHED`); older rows keep their words.
  if (k === 'reason') return word(t, 'audit.reason.', s);
  if (WHO_KEYS.has(k)) return word(t, 'audit.who.', s.toLowerCase());
  if (DATE_KEYS.has(k)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : formatDateTime(d.toISOString(), lang);
  }
  if (k === 'sizeBytes') return bytes(v);
  return s;
}

/**
 * A short, readable view of an audit event's details: the first eight that hold something, named in
 * words where the app knows them. A detail with no value (a subscription row's trial end outside a
 * trial) is left out, so it does not crowd out the reason.
 */
export function auditDetails(t: T, m: Record<string, unknown>, lang: Lang = 'en'): string {
  return Object.entries(m)
    .filter(([, v]) => v !== null && v !== undefined)
    .slice(0, 8)
    .map(([k, v]) => `${keyName(t, k)}: ${value(t, lang, k, v)}`)
    .join(' · ');
}
