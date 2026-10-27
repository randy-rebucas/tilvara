'use client';

import { useState } from 'react';
import { FormError } from '@/components/fields';
import { useSubmit } from '@/components/use-submit';
import { useT } from '@/i18n/client';
import { formatDateTime } from '@/lib/format';

/** Choosing a plan (ADR-0027): a bill to pay now, a change at renewal, or a change at once. */
export function ChoosePlanButton({ planCode, planName, disabled }: { planCode: string; planName: string; disabled: boolean }) {
  const { t, lang } = useT();
  const { pending, submit, error } = useSubmit();
  const [note, setNote] = useState<string | null>(null);
  async function choose() {
    setNote(null);
    const r = await submit<{ effect: 'NOW' | 'BILL' | 'AT_RENEWAL' | 'UNCHANGED'; at?: string }>('PUT', '/api/v1/subscription/plan', { planCode });
    if (!r.ok) return;
    if (r.data.effect === 'AT_RENEWAL') setNote(t('sub.effect.AT_RENEWAL', { plan: planName, date: formatDateTime(r.data.at ?? null, lang) }));
    else if (r.data.effect === 'NOW') setNote(t('sub.effect.NOW'));
    else if (r.data.effect === 'UNCHANGED') setNote(t('sub.effect.UNCHANGED', { plan: planName }));
    // BILL: the new bill appears under Bills with its Pay button.
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <button type="button" className="btn" disabled={pending || disabled} onClick={() => void choose()} data-plan={planCode}>
        {t('sub.choose')}
      </button>
      {note && <span className="text-[0.8125rem] text-muted" role="status">{note}</span>}
      <FormError message={error?.message} />
    </span>
  );
}

/** Opens the provider's payment page for an open bill (one page per bill for a day; a double click reuses it). */
export function PayBillButton({ billId }: { billId: string }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  async function pay() {
    const r = await submit<{ url: string }>('POST', `/api/v1/subscription/bills/${billId}/checkout`, {}, { refresh: false });
    if (r.ok) window.location.assign(r.data.url);
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void pay()} data-bill={billId}>
        {t('sub.pay')}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}

/** Stop at the end of the paid period, or keep going. */
export function CancelToggle({ canceling }: { canceling: boolean }) {
  const { t } = useT();
  const { pending, submit, error } = useSubmit();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={canceling ? 'btn btn-primary' : 'btn'} disabled={pending} onClick={() => void submit('PUT', '/api/v1/subscription/cancel', { cancel: !canceling })}>
        {canceling ? t('sub.resume') : t('sub.stop')}
      </button>
      <FormError message={error?.message} />
    </span>
  );
}
