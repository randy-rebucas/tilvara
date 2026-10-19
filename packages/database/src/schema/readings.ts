import { sql } from 'drizzle-orm';
import { bigint, check, date, foreignKey, integer, jsonb, numeric, pgTable, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { registers } from './organization.js';

const money = (name: string) => numeric(name, { precision: 20, scale: 4 });

/**
 * Z-reading (session 16; fiscal gate G2, not BIR-accredited): the end-of-day reading of one register,
 * once per local business day, numbered per register, carrying the accumulated grand total that never
 * resets (previous + the day's net). Append-only; the figures come from the day's sales and returns.
 */
export const zReadings = pgTable(
  'z_readings',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenantId: uuid('tenant_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    registerId: uuid('register_id').notNull(),
    businessDay: date('business_day').notNull(),
    zNumber: integer('z_number').notNull(),
    resetCounter: integer('reset_counter').notNull().default(0),
    firstSaleNumber: bigint('first_sale_number', { mode: 'number' }),
    lastSaleNumber: bigint('last_sale_number', { mode: 'number' }),
    salesCount: integer('sales_count').notNull(),
    gross: money('gross').notNull(),
    discount: money('discount').notNull(),
    statutoryDiscount: money('statutory_discount').notNull(),
    vatExemptionAmount: money('vat_exemption_amount').notNull(),
    vatableSales: money('vatable_sales').notNull(),
    vatAmount: money('vat_amount').notNull(),
    vatExemptSales: money('vat_exempt_sales').notNull(),
    zeroRatedSales: money('zero_rated_sales').notNull(),
    percentageTaxSales: money('percentage_tax_sales').notNull(),
    salesAmount: money('sales_amount').notNull(),
    returnsCount: integer('returns_count').notNull(),
    returnsAmount: money('returns_amount').notNull(),
    voidsCount: integer('voids_count').notNull(),
    voidsAmount: money('voids_amount').notNull(),
    netAmount: money('net_amount').notNull(),
    previousGrandTotal: money('previous_grand_total').notNull(),
    grandTotal: money('grand_total').notNull(),
    /** Collected per tender method, net of refunds paid out the same way: { CASH: "…", CARD: "…" }. */
    tenders: jsonb('tenders').$type<Record<string, string>>().notNull(),
    /** Statutory discounts by scheme: { SC: "…", PWD: "…" }. */
    statutory: jsonb('statutory').$type<Record<string, string>>().notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('z_readings_tenant_id_id_unique').on(t.tenantId, t.id),
    unique('z_readings_day_unique').on(t.tenantId, t.registerId, t.businessDay),
    unique('z_readings_number_unique').on(t.tenantId, t.registerId, t.zNumber),
    foreignKey({ columns: [t.tenantId, t.branchId, t.registerId], foreignColumns: [registers.tenantId, registers.branchId, registers.id] }),
    check('z_readings_number_check', sql`${t.zNumber} > 0`),
    check('z_readings_net_check', sql`${t.netAmount} = ${t.salesAmount} - ${t.returnsAmount} - ${t.voidsAmount}`),
    check('z_readings_grand_total_check', sql`${t.grandTotal} = ${t.previousGrandTotal} + ${t.netAmount}`),
  ],
);

export type ZReadingRow = typeof zReadings.$inferSelect;
export const Z_READING_NOTE = 'Not a BIR-accredited Z-reading; for the business’s own end-of-day records.';
