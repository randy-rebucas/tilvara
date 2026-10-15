import { priceLists, taxCategories, unitsOfMeasure, type Database } from '@1pos/database';

/**
 * Catalog defaults every new tenant starts with. Tax categories are classification only;
 * VAT rates/rules come from the versioned tax engine (Phase 2).
 */
export async function seedCatalogDefaults(db: Database, tenantId: string): Promise<void> {
  await db.insert(unitsOfMeasure).values([
    { tenantId, code: 'PC', name: 'Piece', allowsFraction: false },
    { tenantId, code: 'KG', name: 'Kilogram', allowsFraction: true },
    { tenantId, code: 'G', name: 'Gram', allowsFraction: true },
    { tenantId, code: 'L', name: 'Liter', allowsFraction: true },
    { tenantId, code: 'ML', name: 'Milliliter', allowsFraction: true },
  ]);
  await db.insert(taxCategories).values([
    { tenantId, code: 'VAT', name: 'VAT-able', vatTreatment: 'VATABLE' },
    { tenantId, code: 'VAT_EXEMPT', name: 'VAT-exempt', vatTreatment: 'VAT_EXEMPT' },
    { tenantId, code: 'ZERO_RATED', name: 'Zero-rated', vatTreatment: 'ZERO_RATED' },
  ]);
  await db.insert(priceLists).values({ tenantId, name: 'Standard', currency: 'PHP', pricesIncludeTax: true, isDefault: true });
}
