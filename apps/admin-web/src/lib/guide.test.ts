import { describe, expect, it } from 'vitest';
import { en, fil } from '../i18n/messages';
import { GUIDE_SECTIONS, guideFor, topicFor } from './guide';
import { NAV_ITEMS } from './nav';

const ALL = ['catalog.read', 'inventory.read', 'purchasing.manage', 'accounting.read', 'reports.read', 'cash.reconcile', 'org.read', 'members.read', 'tenant.manage'];

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

  it('picks the parts for a shop, a sari-sari store and a boutique', () => {
    expect(topicFor('/products', 'RETAIL')).toBe('products');
    // ADR-0020: packs and expiry have their own part; the rest of Inventory stays with inventory.
    expect([topicFor('/inventory/packs', 'GROCERY'), topicFor('/inventory/expiry'), topicFor('/inventory/movements', 'GROCERY')]).toEqual(['tingi', 'tingi', 'inventory']);
    // ADR-0021: promotions, quick keys and labels have their own part; the rest of Prices and Products stay put.
    expect([topicFor('/prices/promotions/abc'), topicFor('/products/labels'), topicFor('/products/quick-keys'), topicFor('/prices'), topicFor('/products/abc')]).toEqual(['retail', 'retail', 'retail', 'prices', 'products']);
    // Categories, units and tax categories are part of Products.
    expect([topicFor('/products/categories'), topicFor('/products/units')]).toEqual(['products', 'products']);
  });

  it('still explains areas the role does not open, marked as such', () => {
    const cashier = guideFor('HYBRID', ['catalog.read', 'sales.create', 'cash.session']);
    const by = Object.fromEntries(cashier.map((s) => [s.id, s.permitted]));
    expect(by).toMatchObject({ start: true, products: true, prices: true, books: false, team: false, salon: false, account: true, till: true });
    expect(cashier).toHaveLength(GUIDE_SECTIONS.length);
  });

  it('a salon gets the appointments part; a shop does not (ADR-0022)', () => {
    const salon = guideFor('SALON', [...ALL, 'appointments.read']);
    expect(salon.map((s) => s.id)).toContain('salon');
    expect(salon.map((s) => s.id)).not.toContain('pharmacy');
    expect(guideFor('RETAIL', ALL).map((s) => s.id)).not.toContain('salon');
    expect(guideFor('HYBRID', ALL).map((s) => s.id)).toContain('salon');
    expect(topicFor('/appointments/staff/abc', 'SALON')).toBe('salon');
    expect(topicFor('/reports/commissions', 'SALON')).toBe('salon');
    expect([topicFor('/reports/tips', 'SALON'), topicFor('/reports/ingredient-usage', 'HYBRID'), topicFor('/products/abc/supplies/def', 'SALON')]).toEqual(['salon', 'salon', 'products']);
    expect(topicFor('/appointments', 'RETAIL')).toBe('subscription');
  });
});

describe('pharmacy guide (ADR-0025)', () => {
  it('a pharmacy gets its part and no salon part; other types do not get it', () => {
    const pharmacy = guideFor('PHARMACY', [...ALL, 'pharmacy.read']).map((s) => s.id);
    expect(pharmacy).toContain('pharmacy');
    expect(pharmacy).toContain('tingi');
    expect(pharmacy).not.toContain('salon');
    expect(guideFor('RETAIL', ALL).map((s) => s.id)).not.toContain('pharmacy');
    expect(guideFor('HYBRID', ALL).map((s) => s.id)).toContain('pharmacy');
    expect(topicFor('/pharmacy/prescriptions/abc', 'PHARMACY')).toBe('pharmacy');
    expect(topicFor('/pharmacy/batches', 'HYBRID')).toBe('pharmacy');
    expect(topicFor('/pharmacy', 'GROCERY')).toBe('subscription');
  });
});
