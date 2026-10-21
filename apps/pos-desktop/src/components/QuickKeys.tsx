import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { api } from '../lib/api';
import { useTill } from '../lib/till';
import { Money } from './ui';

export interface QuickKey {
  position: number;
  variantId: string;
  sku: string;
  name: string;
  price: string | null;
}

/**
 * The till's quick keys (ADR-0021 §3): items without a barcode (or sold often) as buttons, in the order
 * the owner set in the admin. Online from the branch's prices, offline from the till's snapshot.
 */
export function QuickKeys({ branchId, offline, onPick }: { branchId: string; offline: boolean; onPick: (sku: string) => void }) {
  const { t } = useT();
  const till = useTill();
  const [keys, setKeys] = useState<QuickKey[]>([]);
  useEffect(() => {
    let live = true;
    const load = offline && till.engine
      ? till.engine.quickKeys()
      : api<{ data: QuickKey[] }>('GET', `/v1/catalog/quick-keys?branchId=${branchId}`).then((r) => r.data);
    load.then((k) => live && setKeys(k)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [branchId, offline]);
  if (!keys.length) return null;
  return (
    <section aria-label={t('quick.title')} className="no-print" data-testid="quick-keys">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-6">
        {keys.map((k) => (
          <li key={k.variantId}>
            <button
              type="button"
              className="btn h-auto min-h-14 w-full flex-col items-start gap-0.5 px-3 py-2 text-left"
              disabled={!k.price}
              onClick={() => onPick(k.sku)}
            >
              <span className="line-clamp-2 text-[0.875rem] font-semibold leading-tight">{k.name}</span>
              {k.price && <Money value={k.price} className="text-[0.8125rem] text-muted" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
