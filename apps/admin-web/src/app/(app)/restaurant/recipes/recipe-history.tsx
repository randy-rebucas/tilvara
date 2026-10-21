import { Empty, Note, Serial } from '@/components/note';
import type { RecipeVersion } from '@/lib/api';
import { formatDateTime, qty } from '@/lib/format';
import { getT } from '@/i18n/server';

const STATE_TONE = { IN_FORCE: 'chip bg-gold', SCHEDULED: 'tag tag-warn', SUPERSEDED: 'tag' } as const;

/**
 * A recipe's versions (ADR-0014 §4): the one in force, scheduled ones, and the history (append-only,
 * never backdated). Shared by a dish's recipe and a salon service's supplies used (ADR-0022 §9).
 */
export async function RecipeHistory({ history, emptyText }: { history: RecipeVersion[]; emptyText: string }) {
  const { t, lang } = await getT();
  if (history.length === 0) return <Note><Empty>{emptyText}</Empty></Note>;
  return (
    <div className="flex flex-col gap-3">
      {history.map((v) => (
        <Note key={v.id} denom={v.state === 'IN_FORCE' ? 'gold' : 'none'} className="p-4 pr-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">
              <Serial className="text-ink">v{v.version}</Serial> <span className={`ml-2 ${STATE_TONE[v.state]}`}>{t(`rest.state.${v.state}`)}</span>
            </p>
            <Serial>{t('rest.from', { date: formatDateTime(v.effectiveFrom, lang) })}</Serial>
          </div>
          {v.note && <p className="mt-1 text-[0.875rem] text-muted">{v.note}</p>}
          {v.ingredients.length === 0 ? (
            <p className="mt-2 text-[0.875rem] text-muted">{t('rest.noIngredients')}</p>
          ) : (
            <ul className="mt-2">
              {v.ingredients.map((i) => (
                <li key={i.variantId} className="flex justify-between gap-3 border-t border-hair-soft py-1.5 text-[0.9375rem]">
                  <span><Serial className="text-gold">{i.sku}</Serial> {i.name}</span>
                  <span className="money">{qty(i.quantity)} {i.unit}</span>
                </li>
              ))}
            </ul>
          )}
        </Note>
      ))}
    </div>
  );
}
