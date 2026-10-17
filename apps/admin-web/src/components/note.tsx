import type { ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

/** Denomination = the kind of record. Colours never mean anything else. */
export type Denomination = 'blue' | 'violet' | 'orange' | 'green' | 'gold' | 'ink' | 'none';

const stripe: Record<Denomination, string | undefined> = {
  blue: 'var(--color-blue)',
  violet: 'var(--color-violet)',
  orange: 'var(--color-orange-soft)',
  green: 'var(--color-green)',
  gold: 'var(--color-gold-soft)',
  ink: 'var(--color-ink)',
  none: undefined,
};

export function Note({
  denom = 'none',
  className = '',
  children,
  as: Tag = 'section',
  id,
}: {
  denom?: Denomination;
  className?: string;
  children: ReactNode;
  as?: 'section' | 'div' | 'article' | 'li';
  /** An anchor, e.g. a return inside its sale's page. */
  id?: string;
}) {
  return (
    <Tag id={id} className={`note ${className}`}>
      {stripe[denom] && <span className="denom" style={{ background: stripe[denom] }} aria-hidden />}
      {children}
    </Tag>
  );
}

/** Tracked tabular "serial" line: codes, SKUs, TINs, counts. A colour in `className` replaces the muted default. */
export function Serial({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={twMerge('serial text-[0.8125rem] text-muted', className)}>{children}</span>;
}

export function PageHeader({ title, lede, actions }: { title: string; lede?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{title}</h1>
        {lede && <p className="mt-1 max-w-[68ch] text-muted">{lede}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-muted">{children}</p>;
}

export function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const styles = {
    info: 'bg-[#e9eff8] text-[#1f3b66] border-[#c5d4ea]',
    warn: 'bg-amber-bg text-[#6b4a12] border-[#ead3a6]',
    error: 'bg-[#fbeceb] text-red border-[#efc8c6]',
  }[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-[5px] border px-4 py-3 text-[0.875rem] ${styles}`}>
      {children}
    </div>
  );
}
