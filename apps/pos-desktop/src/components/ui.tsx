import type { InputHTMLAttributes, ReactNode } from 'react';
import { useT, type MessageKey } from '../i18n';
import { peso } from '../lib/money';
import type { PaymentIntent } from '../types';

/** Denomination colours (DESIGN.md): blue = catalog/prices, orange = registers, red = harm only. */
export type Denom = 'blue' | 'orange' | 'violet' | 'green';
const DENOM: Record<Denom, string> = { blue: 'bg-blue', orange: 'bg-orange-soft', violet: 'bg-violet', green: 'bg-green' };

export function Note({ denom, className = '', children, ...rest }: { denom?: Denom; className?: string; children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={`note ${denom ? 'pr-6' : ''} ${className}`} {...rest}>
      {children}
      {denom && <span aria-hidden className={`denom ${DENOM[denom]}`} />}
    </section>
  );
}

export function Field({ label, hint, error, id, className, ...input }: { label: string; hint?: string; error?: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...input} className={`input ${className ?? ''}`} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-hint` : undefined} />
      {(error || hint) && (
        <p id={`${id}-hint`} className={`hint ${error ? 'text-red' : ''}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

/**
 * An empty list (DESIGN.md): left-aligned like the rows it stands in for, saying what belongs there
 * or what to do first, with the way to it when there is one.
 */
export function Empty({ children, action, className = '' }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-5 ${className}`}>
      <p className="min-w-0 max-w-[68ch] text-muted">{children}</p>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Callout({ kind, children }: { kind: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`callout callout-${kind}`}>
      {children}
    </div>
  );
}

/** Card/QR payment state in words (never the raw enum); amber while unanswered, red when not charged. */
export function PaymentTag({ status }: { status: PaymentIntent['status'] }) {
  const { t } = useT();
  const tone = status === 'UNKNOWN' || status === 'PROCESSING' ? 'tag-warn' : status === 'FAILED' || status === 'CANCELED' ? 'tag-bad' : '';
  return <span className={`tag ${tone}`}>{t(`pay.status.${status}` as MessageKey)}</span>;
}

export const methodLabel = (method: PaymentIntent['method']): MessageKey => (method === 'CARD' ? 'pay.card' : 'pay.qr');

export function Money({ value, className = '' }: { value: string | null | undefined; className?: string }) {
  return <span className={`money ${className}`}>{peso(value)}</span>;
}
