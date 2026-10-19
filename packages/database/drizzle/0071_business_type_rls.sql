-- Hand-written: the business type (session 17). Existing businesses keep every feature: the column
-- default HYBRID filled them in 0070. The owner changes it through the app (tenant.manage).
GRANT UPDATE (business_type) ON tenants TO onepos_app;--> statement-breakpoint
-- The data export's manifest names it.
GRANT SELECT (business_type) ON tenants TO onepos_worker;
