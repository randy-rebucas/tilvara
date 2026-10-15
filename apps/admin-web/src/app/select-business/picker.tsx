'use client';

import { Check, ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { FormError } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import type { Me } from '@/lib/api';

export function BusinessPicker({ memberships, activeTenantId }: { memberships: Me['memberships']; activeTenantId: string | null }) {
  const router = useRouter();
  const { pending, error, submit } = useSubmit();

  async function choose(tenantId: string) {
    const r = await submit('POST', '/api/auth/switch', { tenantId }, { refresh: false });
    if (r.ok) router.replace('/');
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
                <Check aria-label="current" className="size-5 text-blue" />
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
