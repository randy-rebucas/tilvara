-- Sample items of the removed trades (session 36, retail fit audit). Businesses that tried Tilvara as a
-- café, a laundry or another removed trade still had its sample set on sale ("Iced coffee 16oz (sample)",
-- "Wash-dry-fold (per kilo) (sample)", …), shown in Products and rung up at the till. Tilvara made
-- those, so they are archived here, as "Remove sample items" does: in every business still holding an
-- active sample that is not in today's retail set (`SAMPLE_ITEMS` in apps/api/src/catalog/catalog.service.ts,
-- copied below as of this migration), all its active sample items, their variants and barcodes, and
-- its sample categories. Archived, never deleted: old sales still point at them. The owners' own
-- items from those trades stay; each owner may archive them.
-- Tables read and written under FORCE RLS as the migrator: NO FORCE around the statements.
ALTER TABLE products NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_variants NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE barcodes NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE categories NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TEMP TABLE retired_sample_tenants ON COMMIT DROP AS
SELECT DISTINCT tenant_id FROM products
 WHERE is_sample AND archived_at IS NULL
   AND regexp_replace(name, ' \(sample\)$', '') NOT IN (
     'Rice 5 kg', 'Instant noodles', 'Canned sardines 155g', 'Laundry soap bar',
     'Cooking oil 1 L', 'Bottled water 500ml', 'Ballpen (blue)', 'AA batteries (2 pcs)');--> statement-breakpoint

CREATE TEMP TABLE retired_sample_products ON COMMIT DROP AS
SELECT p.tenant_id, p.id FROM products p JOIN retired_sample_tenants t ON t.tenant_id = p.tenant_id
 WHERE p.is_sample AND p.archived_at IS NULL;--> statement-breakpoint

UPDATE barcodes b SET archived_at = now()
  FROM product_variants v JOIN retired_sample_products r ON r.tenant_id = v.tenant_id AND r.id = v.product_id
 WHERE b.tenant_id = v.tenant_id AND b.variant_id = v.id AND b.archived_at IS NULL AND v.archived_at IS NULL;--> statement-breakpoint

UPDATE product_variants v SET archived_at = now()
  FROM retired_sample_products r
 WHERE r.tenant_id = v.tenant_id AND r.id = v.product_id AND v.archived_at IS NULL;--> statement-breakpoint

UPDATE products p SET archived_at = now()
  FROM retired_sample_products r
 WHERE r.tenant_id = p.tenant_id AND r.id = p.id;--> statement-breakpoint

UPDATE categories c SET archived_at = now()
  FROM retired_sample_tenants t
 WHERE t.tenant_id = c.tenant_id AND c.is_sample AND c.archived_at IS NULL;--> statement-breakpoint

ALTER TABLE products FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE product_variants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE barcodes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
