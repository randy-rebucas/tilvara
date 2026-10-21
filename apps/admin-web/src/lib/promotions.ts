import type { MessageKey } from '@/i18n/messages';
import type { Promotion } from './api';
import { peso, percentFromRate, qty } from './format';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;
export type PromotionTerms = Pick<Promotion, 'kind' | 'quantity' | 'price' | 'buyQuantity' | 'getQuantity' | 'getRate' | 'tiers'>;

/** A rate that means "free" ("1", "1.0"). */
export const isFree = (rate: string | null | undefined) => !!rate && /^1(\.0*)?$/.test(rate.trim());

/** The terms in plain words: "3 for ₱800", "Buy 2, get 1 free", "5% off 6 or more · 10% off 12 or more". */
export function describePromotion(p: PromotionTerms, t: T): string {
  switch (p.kind) {
    case 'MULTI_BUY':
      return t('promo.desc.multi', { n: p.quantity ?? '?', price: peso(p.price) });
    case 'BUY_X_GET_Y':
      return isFree(p.getRate)
        ? t('promo.desc.free', { buy: p.buyQuantity ?? '?', get: p.getQuantity ?? '?' })
        : t('promo.desc.off', { buy: p.buyQuantity ?? '?', get: p.getQuantity ?? '?', pct: percentFromRate(p.getRate ?? '0') });
    case 'QUANTITY_BREAK':
      return (p.tiers ?? []).map((tier) => t('promo.desc.tier', { pct: percentFromRate(tier.rate), min: qty(tier.minQuantity) })).join(' · ');
  }
}
