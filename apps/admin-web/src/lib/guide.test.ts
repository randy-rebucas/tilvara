import { describe, expect, it } from 'vitest';
import { en, fil } from '../i18n/messages';
import { GUIDE_SECTIONS, guideFor, topicFor } from './guide';
import { NAV_ITEMS } from './nav';

const ALL = ['catalog.read', 'inventory.read', 'purchasing.manage', 'accounting.read', 'restaurant.manage', 'reports.read', 'cash.reconcile', 'org.read', 'members.read', 'tenant.manage'];

describe('user guide', () => {
  it('words every section, step and tip in English and Filipino', () => {
    for (const dict of [en, fil] as Record<string, string>[]) {
      for (const s of GUIDE_SECTIONS) {
        for (const key of [s.title, s.lede, ...s.steps.map((l) => l.key), ...s.tips.map((l) => l.key)]) {
          expect(dict[key], key).toBeTruthy();
        }
      }
    }
  });

  it('has no guide copy that no section shows (a step added to the catalog but not counted)', () => {
    const used = new Set(GUIDE_SECTIONS.flatMap((s) => [s.lede, ...s.steps.map((l) => l.key), ...s.tips.map((l) => l.key)]));
    const orphans = Object.keys(en).filter((k) => /^guide\.[a-z]+\.(lede|s\d+|t\d+)$/.test(k) && !used.has(k as never));
    expect(orphans).toEqual([]);
  });

  it('covers every tab of the band, and the band help button lands on its section', () => {
    const ids = GUIDE_SECTIONS.map((s) => s.id);
    for (const item of NAV_ITEMS) {
      expect(ids).toContain(topicFor(item.href));
      if (item.href !== '/') expect(GUIDE_SECTIONS.find((s) => s.id === topicFor(item.href))?.area, item.href).toBe(item);
    }
  });

  it('picks the section for nested pages and falls back to getting started', () => {
    expect(topicFor('/inventory/count-sheets/abc')).toBe('inventory');
    expect(topicFor('/reports/z-readings')).toBe('reports');
    expect(topicFor('/sales/123')).toBe('reports');
    expect(topicFor('/shifts')).toBe('drawers');
    expect(topicFor('/shifts/abc')).toBe('drawers');
    expect(topicFor('/audit')).toBe('team');
    expect(topicFor('/offline-sales')).toBe('offline');
    expect(topicFor('/')).toBe('start');
    expect(topicFor('/help')).toBe('start');
    expect(topicFor('/productsx')).toBe('start');
  });

  it('sends a retail shop on a restaurant page to the part about changing the type of business', () => {
    expect(topicFor('/restaurant/menus', 'RETAIL')).toBe('subscription');
    expect(topicFor('/restaurant/menus', 'RESTAURANT')).toBe('restaurant');
    expect(topicFor('/products', 'RETAIL')).toBe('products');
  });

  it('leaves restaurant service out for a retail shop, and selling by weight out for a restaurant', () => {
    const retail = guideFor('RETAIL', ALL);
    expect(retail.map((s) => s.id)).not.toContain('restaurant');
    expect(retail.flatMap((s) => [...s.steps, ...s.tips]).some((l) => l.only === 'restaurant')).toBe(false);
    expect(retail.find((s) => s.id === 'products')!.tips.map((l) => l.key)).toContain('guide.products.t1');

    const restaurant = guideFor('RESTAURANT', ALL);
    expect(restaurant.map((s) => s.id)).toContain('restaurant');
    expect(restaurant.find((s) => s.id === 'products')!.tips.map((l) => l.key)).not.toContain('guide.products.t1');
    expect(restaurant.find((s) => s.id === 'reports')!.steps.map((l) => l.key)).toContain('guide.reports.s5');

    const both = guideFor('HYBRID', ALL);
    expect(both).toHaveLength(GUIDE_SECTIONS.length);
  });

  it('a plan without restaurant service leaves it out like a retail shop does (session 22)', () => {
    const starter = guideFor('RESTAURANT', ALL, []);
    expect(starter.map((s) => s.id)).not.toContain('restaurant');
    expect(topicFor('/restaurant/menus', 'RESTAURANT', [])).toBe('subscription');
    expect(topicFor('/restaurant/menus', 'RESTAURANT', ['restaurant'])).toBe('restaurant');
    expect(guideFor('HYBRID', ALL, ['restaurant'])).toHaveLength(GUIDE_SECTIONS.length);
  });

  it('still explains areas the role does not open, marked as such', () => {
    const cashier = guideFor('HYBRID', ['catalog.read', 'sales.create', 'cash.session', 'restaurant.orders']);
    const by = Object.fromEntries(cashier.map((s) => [s.id, s.permitted]));
    expect(by).toMatchObject({ start: true, products: true, prices: true, books: false, team: false, restaurant: false, account: true, till: true });
  });
});
