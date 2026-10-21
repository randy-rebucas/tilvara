'use client';

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useId } from 'react';

export function TextField({
  label,
  hint,
  error,
  labelClassName,
  ...props
}: { label: string; hint?: string; error?: string | undefined; /** e.g. `sr-only` on repeated rows. */ labelClassName?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id} className={labelClassName}>{label}</label>
      <input
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? hintId : undefined}
        {...props}
      />
      {(error || hint) && (
        <p id={hintId} className={`hint ${error ? 'text-red!' : ''}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  children,
  ...props
}: { label: string; hint?: string; error?: string | undefined; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="input" aria-invalid={error ? true : undefined} aria-describedby={hint || error ? hintId : undefined} {...props}>
        {children}
      </select>
      {(error || hint) && <p id={hintId} className={`hint ${error ? 'text-red!' : ''}`}>{error ?? hint}</p>}
    </div>
  );
}

export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-[5px] border border-[#efc8c6] bg-[#fbeceb] px-3 py-2 text-[0.875rem] text-red">
      {message}
    </p>
  );
}
