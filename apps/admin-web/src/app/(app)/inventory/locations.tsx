'use client';

import { useState } from 'react';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';

/**
 * Where an item sits in this branch (ADR-0021 §5), edited in its row: saved on Enter or on leaving
 * the field when it changed; an empty field removes it. The server writes it in capitals.
 */
export function LocationCell({ branchId, variantId, name, location }: { branchId: string; variantId: string; name: string; location: string | null }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  const [value, setValue] = useState(location ?? '');
  const [saved, setSaved] = useState(location ?? '');
  async function save() {
    const next = value.trim().toUpperCase();
    if (next === saved) return setValue(next);
    const r = await submit('PUT', '/api/v1/stock/locations', { branchId, items: [{ variantId, location: next || null }] }, { refresh: false });
    if (r.ok) {
      setSaved(next);
      setValue(next);
    }
  }
  return (
    <span className="inline-flex flex-col items-start">
      <label className="sr-only" htmlFor={`loc-${variantId}`}>{t('shelf.locationOf', { name })}</label>
      <input
        id={`loc-${variantId}`}
        className="input serial h-8 w-28 text-[0.8125rem] uppercase"
        maxLength={32}
        value={value}
        disabled={pending}
        placeholder="—"
        aria-invalid={error ? true : undefined}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
          if (e.key === 'Escape') setValue(saved);
        }}
      />
      {error && <span role="alert" className="mt-0.5 text-[0.75rem] text-red">{error.message}</span>}
    </span>
  );
}
