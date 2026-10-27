'use client';

import { Check, ChevronRight } from 'lucide-react';
import { FormError } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import type { Me } from '@/lib/api';
import { useT } from '@/i18n/client';
import { extraFor } from '@/i18n/titles';

export function BusinessPicker({ memberships, activeTenantId }: { memberships: Me['memberships']; activeTenantId: string | null }) {
  const { lang } = useT();
  const { pending, error, submit } = useSubmit();

  async function choose(tenantId: string) {
    const r = await submit<{ redirect?: string }>('POST', '/api/auth/switch', { tenantId }, { refresh: false });
    // A business with its own address (session 41) is opened there.
    if (r.ok && r.data.redirect) window.location.assign(r.data.redirect);
    // A full load: no page of the previous business stays in the router cache.
    else if (r.ok) window.location.assign('/');
  }

  return (
    <div className="mt-6 flex flex-col gap-3">
      <FormError message={error?.message} />
      <ul className="flex flex-col gap-3">
        {memberships.map((m) => (
          <li key={m.tenantId}>
            <button
              type="button"
              disabled={pending}
              onClick={() => choose(m.tenantId)}
              className="note flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-white"
            >
              <span>
                <span className="block text-[1.0625rem] font-semibold">{m.tenantName}</span>
                <span className="serial text-[0.8125rem] text-muted">
                  {m.tenantSlug} · {m.tenantStatus}
                </span>
              </span>
              {m.tenantId === activeTenantId ? (
                <Check aria-label={extraFor(lang, 'a11y.current')} className="size-5 text-blue" />
              ) : (
                <ChevronRight aria-hidden className="size-5 text-muted" />
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
