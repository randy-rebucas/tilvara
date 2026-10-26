'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

export interface VariantOption {
  id: string;
  label: string;
}

export interface LineField {
  name: string;
  label: string;
  /** `select` picks from `options` (items, accounts). */
  kind: 'select' | 'decimal' | 'text' | 'date';
  placeholder?: string;
}

/**
 * Editable document lines (order, transfer, count, journal). Inputs are named
 * `lines.<i>.<field>` so the API's validation paths map straight back onto them.
 */
export function LineItems({
  fields,
  options,
  fieldError,
  addLabel,
  removeLabel,
  min = 1,
  initial,
}: {
  fields: LineField[];
  options: VariantOption[];
  fieldError: (path: string) => string | undefined;
  addLabel: string;
  removeLabel: string;
  min?: number;
  /** Rows to start from (e.g. a draft being edited), keyed by field name. */
  initial?: Record<string, string>[];
}) {
  const base = useId();
  const start = Math.max(min, initial?.length ?? 0);
  const [rows, setRows] = useState(() => Array.from({ length: start }, (_, i) => i));
  const [next, setNext] = useState(start);
  const cols = `minmax(0,2fr) ${fields.slice(1).map(() => 'minmax(0,1fr)').join(' ')} auto`;
  return (
    <div className="col-span-full flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={row} className="grid gap-2 rounded-[5px] border border-hair-soft p-2 @lg:border-0 @lg:p-0 @lg:[grid-template-columns:var(--cols)]" style={{ '--cols': cols } as React.CSSProperties}>
          {fields.map((f) => {
            const name = `lines.${i}.${f.name}`;
            const id = `${base}-${row}-${f.name}`;
            const error = fieldError(name);
            const value = initial?.[row]?.[f.name] ?? '';
            return (
              <div key={f.name} className="field min-w-0">
                <label htmlFor={id} className={i > 0 ? '@lg:sr-only' : undefined}>{f.label}</label>
                {f.kind === 'select' ? (
                  <select id={id} name={name} className="input" defaultValue={value} aria-invalid={error ? true : undefined}>
                    <option value="" disabled>—</option>
                    {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                ) : (
                  <input id={id} name={name} className="input" defaultValue={value} type={f.kind === 'date' ? 'date' : undefined} inputMode={f.kind === 'decimal' ? 'decimal' : undefined} placeholder={f.placeholder} aria-invalid={error ? true : undefined} />
                )}
                {error && <p className="hint text-red!">{error}</p>}
              </div>
            );
          })}
          <div className={`flex items-end ${i === 0 ? '@lg:pt-[1.55rem]' : ''}`}>
            <button
              type="button"
              className="btn h-[2.4rem] px-2.5"
              aria-label={`${removeLabel} ${i + 1}`}
              disabled={rows.length <= min}
              onClick={() => setRows((r) => r.filter((x) => x !== row))}
            >
              <Trash2 aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      ))}
      <div>
        <button type="button" className="btn" onClick={() => { setRows((r) => [...r, next]); setNext((n) => n + 1); }}>
          <Plus aria-hidden className="size-4" /> {addLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * Read `lines.<i>.<field>` inputs back into objects. Every row is kept (even an empty one) so the
 * API's `lines.<i>` error paths land on the row the user sees.
 */
export function readLines(form: FormData, fields: string[]): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (let i = 0; fields.some((f) => form.has(`lines.${i}.${f}`)); i++) {
    out.push(Object.fromEntries(fields.map((f) => [f, String(form.get(`lines.${i}.${f}`) ?? '').trim()])));
  }
  return out;
}

/** Drop empty strings so optional API fields are omitted rather than sent blank. */
export function compact<K extends string>(row: Record<K, string | undefined>): Partial<Record<K, string>> {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== '' && v !== undefined)) as Partial<Record<K, string>>;
}
