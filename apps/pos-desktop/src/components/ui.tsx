import type { InputHTMLAttributes, ReactNode } from 'react';
import { peso } from '../lib/money';

/** Denomination colours (DESIGN.md): blue = catalog/prices, orange = registers, red = harm only. */
type Denom = 'blue' | 'orange' | 'violet' | 'green';
const DENOM: Record<Denom, string> = { blue: 'bg-blue', orange: 'bg-orange-soft', violet: 'bg-violet', green: 'bg-green' };

export function Note({ denom, className = '', children, ...rest }: { denom?: Denom; className?: string; children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={`note ${denom ? 'pr-6' : ''} ${className}`} {...rest}>
      {children}
      {denom && <span aria-hidden className={`denom ${DENOM[denom]}`} />}
    </section>
  );
}

export function Field({ label, hint, error, id, ...input }: { label: string; hint?: string; error?: string; id: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className={`input ${input.className ?? ''}`} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-hint` : undefined} {...input} />
      {(error || hint) && (
        <p id={`${id}-hint`} className={`hint ${error ? 'text-red' : ''}`}>
          {error ?? hint}
        </p>
      )}
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

export function Money({ value, className = '' }: { value: string | null | undefined; className?: string }) {
  return <span className={`money ${className}`}>{peso(value)}</span>;
}
