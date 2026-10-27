import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  customerConsentEvents,
  customerCreditEntries,
  customers,
  desc,
  eq,
  isNull,
  legalEntities,
  registers,
  saleLines,
  saleReturns,
  sales,
  sql,
  inArray,
  inSequence,
  type Database,
} from '@1pos/database';
import { toDec } from '@1pos/money';
import type {
  AnonymiseCustomerInput,
  CreateCustomerInput,
  CustomerConsentInput,
  CustomerHistoryQuery,
  CustomerListQuery,
  UpdateCustomerInput,
} from '@1pos/validation';
import { tenantOf, type AuthContext } from '../auth/auth-context.js';
import { hasPermission } from '../auth/authorization.js';
import { archived, notFound, TenantService, type ConflictMap } from '../common/tenant-service.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { TenantDb } from '../infrastructure/tenant-db.service.js';

type CustomerRow = typeof customers.$inferSelect;

const money = (v: string) => toDec(v).toFixed(2);
/** A business-wide record: a grant at any scope opens it (like the catalog; ADR-0018). */
const holds = (auth: AuthContext, perm: 'customers.read' | 'customers.manage') => tenantOf(auth).grants.some((g) => g.permission === perm);
/** A cashier opens the sales they rang; an API key answers as the person who made it, so never (audit 2026-10-27 #21). */
const ownSale = (auth: AuthContext, cashierUserId: string) => !auth.apiKey && cashierUserId === auth.userId;

/** Load a customer for a sale or a refund as store credit (404 across tenants, 409 archived). */
export async function activeCustomer(db: Database, id: string) {
  const [row] = await db.select().from(customers).where(eq(customers.id, id));
  if (!row) throw notFound('Customer');
  if (row.archivedAt) throw archived('Customer');
  return row;
}

/** Store credit a customer holds with one legal entity (Σ entries; the DB trigger keeps it ≥ 0). */
export async function creditBalance(db: Database, customerId: string, legalEntityId: string) {
  const { rows } = await db.execute<{ v: string }>(
    sql`SELECT coalesce(sum(amount), 0)::text AS v FROM customer_credit_entries WHERE customer_id = ${customerId} AND legal_entity_id = ${legalEntityId}`,
  );
  return toDec(rows[0]!.v);
}

/**
 * Customer management (SPEC §6.9, ADR-0018). Profiles are business-wide: `customers.read` at any
 * scope searches and opens them, `customers.manage` creates, corrects, records consent, exports and
 * anonymises. Purchase history shows only the sales the person may read. Every change is audited by
 * field name, never by value, so the audit log does not become a second copy of personal data.
 */
@Injectable()
export class CustomersService extends TenantService {
  protected readonly conflicts: ConflictMap = {
    customers_code_active_unique: ['CUSTOMER_CODE_TAKEN', 'An active customer already has this number'],
  };

  constructor(@Inject(TenantDb) tenantDb: TenantDb) {
    super(tenantDb);
  }

  private assertRead(auth: AuthContext) {
    if (!holds(auth, 'customers.read') && !holds(auth, 'customers.manage')) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: ['customers.read'] });
    }
  }

  private assertManage(auth: AuthContext) {
    if (!holds(auth, 'customers.manage')) {
      throw new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: ['customers.manage'] });
    }
  }

  private async load(db: Database, id: string) {
    const [row] = await db.select().from(customers).where(eq(customers.id, id));
    if (!row) throw notFound('Customer');
    return row;
  }

  create(auth: AuthContext, input: CreateCustomerInput) {
    return this.mutate(auth, async (db) => {
      this.assertManage(auth);
      const { marketingConsent, consentSource, ...profile } = input;
      const [row] = await db
        .insert(customers)
        .values({
          tenantId: tenantOf(auth).tenantId,
          ...profile,
          marketingConsent,
          marketingConsentAt: marketingConsent ? sql`now()` : null,
          createdBy: auth.userId,
        })
        .returning();
      if (marketingConsent) await this.consentEvent(db, auth, row!.id, true, consentSource);
      await this.audit(db, auth, 'customer.created', 'customer', row!.id, { fields: Object.keys(profile).filter((k) => profile[k as keyof typeof profile] != null), marketingConsent });
      return this.view(db, auth, row!);
    });
  }

  /** A correction (the customer asked, or a typo): overwrites the fields given; audited by field name. */
  update(auth: AuthContext, id: string, input: UpdateCustomerInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.load(db, id);
      this.assertManage(auth);
      if (current.anonymisedAt) throw new AppError('CUSTOMER_ANONYMISED', 'This customer was anonymised; nothing can be added back', HttpStatus.CONFLICT);
      if (current.archivedAt) throw archived('Customer');
      const changed = Object.entries(input).filter(([k, v]) => v !== undefined && v !== current[k as keyof CustomerRow]).map(([k]) => k);
      const [row] = await db.update(customers).set({ ...input, updatedAt: sql`now()` }).where(eq(customers.id, id)).returning();
      if (changed.length) await this.audit(db, auth, 'customer.corrected', 'customer', id, { fields: changed });
      return this.view(db, auth, row!);
    });
  }

  /**
   * Marketing consent given or withdrawn, with how it was given; kept as history. A withdrawal is also
   * recorded in a suspended or lapsed business (a customer's "stop" must be honoured whatever the
   * subscription); giving consent is not.
   */
  consent(auth: AuthContext, id: string, input: CustomerConsentInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.load(db, id);
      this.assertRead(auth);
      if (current.marketingConsent === input.marketingConsent) return this.view(db, auth, current);
      // Withdrawing is open to whoever may open the customer: a "stop" must never wait for a manager.
      if (input.marketingConsent) this.assertManage(auth);
      if (current.anonymisedAt) throw new AppError('CUSTOMER_ANONYMISED', 'This customer was anonymised; nothing can be added back', HttpStatus.CONFLICT);
      const [row] = await db
        .update(customers)
        .set({ marketingConsent: input.marketingConsent, marketingConsentAt: input.marketingConsent ? sql`now()` : null, updatedAt: sql`now()` })
        .where(eq(customers.id, id))
        .returning();
      await this.consentEvent(db, auth, id, input.marketingConsent, input.source);
      await this.audit(db, auth, input.marketingConsent ? 'customer.consent_given' : 'customer.consent_withdrawn', 'customer', id, { source: input.source });
      return this.view(db, auth, row!);
    }, { allowReadOnlyBusiness: !input.marketingConsent });
  }

  archive(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const current = await this.load(db, id);
      this.assertManage(auth);
      if (current.archivedAt) return this.view(db, auth, current);
      const [row] = await db.update(customers).set({ archivedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(customers.id, id)).returning();
      await this.audit(db, auth, 'customer.archived', 'customer', id);
      return this.view(db, auth, row!);
    });
  }

  /**
   * Blank every personal field for good (the customer asked to be forgotten, or the retention period
   * ended). The row stays, named "Anonymised customer", so the fiscal records that point at it keep
   * their integrity; store credit must be spent or settled first (it is owed to someone). A suspended or
   * lapsed business must still answer an erasure request, so this write is allowed then.
   */
  anonymise(auth: AuthContext, id: string, input: AnonymiseCustomerInput) {
    return this.mutate(auth, async (db) => {
      const current = await this.load(db, id);
      this.assertManage(auth);
      if (current.anonymisedAt) return this.view(db, auth, current);
      const { rows } = await db.execute<{ legal_entity_id: string; v: string }>(
        sql`SELECT legal_entity_id, sum(amount)::text AS v FROM customer_credit_entries WHERE customer_id = ${id} GROUP BY 1 HAVING sum(amount) <> 0`,
      );
      if (rows.length) {
        throw new AppError('CUSTOMER_HAS_CREDIT', 'This customer still has store credit; it must be used first', HttpStatus.CONFLICT, {
          balances: rows.map((r) => ({ legalEntityId: r.legal_entity_id, balance: money(r.v) })),
        });
      }
      const [row] = await db
        .update(customers)
        .set({
          displayName: 'Anonymised customer', code: null, phone: null, email: null, tin: null, address: null, notes: null,
          marketingConsent: false, marketingConsentAt: null, archivedAt: current.archivedAt ?? sql`now()`, anonymisedAt: sql`now()`, updatedAt: sql`now()`,
        })
        .where(eq(customers.id, id))
        .returning();
      await this.audit(db, auth, 'customer.anonymised', 'customer', id, { reason: input.reason });
      return this.view(db, auth, row!);
    }, { allowReadOnlyBusiness: true });
  }

  get(auth: AuthContext, id: string) {
    return this.read(auth, async (db) => {
      const row = await this.load(db, id);
      this.assertRead(auth);
      return this.view(db, auth, row);
    });
  }

  /** Search by name, phone, email or number; newest first, cursor-paged. */
  list(auth: AuthContext, q: CustomerListQuery) {
    return this.read(auth, async (db) => {
      this.assertRead(auth);
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const rows = await db
        .select()
        .from(customers)
        .where(
          and(
            q.includeArchived ? undefined : isNull(customers.archivedAt),
            like
              ? sql`(${customers.displayName} ILIKE ${like} OR ${customers.phone} ILIKE ${like} OR ${customers.email} ILIKE ${like} OR ${customers.code} ILIKE ${like})`
              : undefined,
            q.cursor ? sql`${customers.id} < ${q.cursor}` : undefined,
          ),
        )
        .orderBy(desc(customers.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { data: page.map((c) => this.summary(c)), nextCursor: rows.length > q.limit ? page.at(-1)!.id : null };
    });
  }

  /** The customer's purchases the person may read (sales.read at the sale's scope, or their own sales). */
  history(auth: AuthContext, id: string, q: CustomerHistoryQuery) {
    return this.read(auth, async (db) => {
      await this.load(db, id);
      this.assertRead(auth);
      const rows = await db
        .select({ sale: sales, registerCode: registers.code })
        .from(sales)
        .innerJoin(registers, eq(registers.id, sales.registerId))
        .where(and(eq(sales.customerId, id), q.cursor ? sql`${sales.id} < ${q.cursor}` : undefined))
        .orderBy(desc(sales.id))
        .limit(q.limit + 1);
      const visible = rows.filter(({ sale: s }) => ownSale(auth, s.cashierUserId) || hasPermission(tenantOf(auth).grants, 'sales.read', { legalEntityId: s.legalEntityId, branchId: s.branchId, registerId: s.registerId }));
      return {
        data: visible.slice(0, q.limit).map(({ sale: s, registerCode }) => ({
          id: s.id, saleNumber: s.saleNumber, reference: `${registerCode}-${String(s.saleNumber).padStart(6, '0')}`, branchId: s.branchId,
          completedAt: s.completedAt, amountDue: money(s.amountDue),
        })),
        nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.sale.id : null,
      };
    });
  }

  /**
   * Everything the business holds about the customer, as one JSON document (a data subject's access
   * request, privacy pack): the profile, consent history, purchases with their lines and store credit.
   * A suspended or lapsed business must still answer such a request, so this write (its audit row) is allowed then.
   */
  export(auth: AuthContext, id: string) {
    return this.mutate(auth, async (db) => {
      const row = await this.load(db, id);
      this.assertManage(auth);
      const [consents, credit, bought] = await inSequence(
        () => db.select().from(customerConsentEvents).where(eq(customerConsentEvents.customerId, id)).orderBy(asc(customerConsentEvents.recordedAt)),
        () => db.select().from(customerCreditEntries).where(eq(customerCreditEntries.customerId, id)).orderBy(asc(customerCreditEntries.createdAt)),
        () => db.select({ sale: sales, registerCode: registers.code }).from(sales).innerJoin(registers, eq(registers.id, sales.registerId)).where(eq(sales.customerId, id)).orderBy(asc(sales.completedAt), asc(sales.saleNumber), asc(sales.id)),
      );
      const lines = bought.length
        ? await db.select().from(saleLines).where(inArray(saleLines.saleId, bought.map((b) => b.sale.id))).orderBy(asc(saleLines.saleId), asc(saleLines.lineNo))
        : [];
      await this.audit(db, auth, 'customer.exported', 'customer', id);
      return {
        format: 'tilvara-customer-export/1',
        exportedAt: new Date().toISOString(),
        customer: {
          id: row.id, code: row.code, displayName: row.displayName, phone: row.phone, email: row.email, tin: row.tin, address: row.address, notes: row.notes,
          marketingConsent: row.marketingConsent, marketingConsentAt: row.marketingConsentAt, createdAt: row.createdAt, archivedAt: row.archivedAt, anonymisedAt: row.anonymisedAt,
        },
        consentHistory: consents.map((c) => ({ purpose: c.purpose, granted: c.granted, source: c.source, recordedAt: c.recordedAt })),
        purchases: bought.map(({ sale: s, registerCode }) => ({
          reference: `${registerCode}-${String(s.saleNumber).padStart(6, '0')}`, completedAt: s.completedAt, amountDue: money(s.amountDue),
          lines: lines.filter((l) => l.saleId === s.id).map((l) => ({ name: l.name, quantity: toDec(l.quantity).toString(), amountDue: money(l.amountDue) })),
        })),
        storeCredit: credit.map((e) => ({ kind: e.kind, amount: money(e.amount), createdAt: e.createdAt })),
      };
    }, { allowReadOnlyBusiness: true });
  }

  /**
   * The store credit ledger of a customer, newest first, cursor-paged, with the document behind each entry.
   * `canOpen`: the person may open that document (the sale's rule: sales.read at its scope, or their own sale).
   */
  credit(auth: AuthContext, id: string, q: CustomerHistoryQuery) {
    return this.read(auth, async (db) => {
      await this.load(db, id);
      this.assertRead(auth);
      const rows = await db
        .select({ e: customerCreditEntries, sale: { legalEntityId: sales.legalEntityId, branchId: sales.branchId, registerId: sales.registerId, cashierUserId: sales.cashierUserId } })
        .from(customerCreditEntries)
        .leftJoin(saleReturns, eq(saleReturns.id, customerCreditEntries.saleReturnId))
        .leftJoin(sales, sql`${sales.id} = coalesce(${customerCreditEntries.saleId}, ${saleReturns.saleId})`)
        .where(and(eq(customerCreditEntries.customerId, id), q.cursor ? sql`${customerCreditEntries.id} < ${q.cursor}` : undefined))
        .orderBy(desc(customerCreditEntries.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const canOpen = (s: (typeof rows)[number]['sale']) =>
        !!s && (ownSale(auth, s.cashierUserId) || hasPermission(tenantOf(auth).grants, 'sales.read', { legalEntityId: s.legalEntityId, branchId: s.branchId, registerId: s.registerId }));
      return {
        data: page.map(({ e, sale }) => ({
          id: e.id, legalEntityId: e.legalEntityId, branchId: e.branchId, kind: e.kind, amount: money(e.amount), saleId: e.saleId, saleReturnId: e.saleReturnId, createdAt: e.createdAt,
          canOpen: canOpen(sale),
        })),
        nextCursor: rows.length > q.limit ? page.at(-1)!.e.id : null,
      };
    });
  }

  private consentEvent(db: Database, auth: AuthContext, customerId: string, granted: boolean, source: CustomerConsentInput['source']) {
    return db.insert(customerConsentEvents).values({ tenantId: tenantOf(auth).tenantId, customerId, granted, source, recordedBy: auth.userId });
  }

  private summary(c: CustomerRow) {
    return {
      id: c.id, code: c.code, displayName: c.displayName, phone: c.phone, email: c.email, tin: c.tin,
      marketingConsent: c.marketingConsent, archivedAt: c.archivedAt, anonymisedAt: c.anonymisedAt, createdAt: c.createdAt,
    };
  }

  private async view(db: Database, auth: AuthContext, c: CustomerRow) {
    const { rows } = await db.execute<{ legal_entity_id: string; v: string }>(
      sql`SELECT legal_entity_id, sum(amount)::text AS v FROM customer_credit_entries WHERE customer_id = ${c.id} GROUP BY 1`,
    );
    const entities = rows.length ? await db.select({ id: legalEntities.id, name: legalEntities.tradeName, registeredName: legalEntities.registeredName }).from(legalEntities).where(inArray(legalEntities.id, rows.map((r) => r.legal_entity_id))) : [];
    return {
      ...this.summary(c),
      address: c.address,
      notes: c.notes,
      marketingConsentAt: c.marketingConsentAt,
      updatedAt: c.updatedAt,
      storeCredit: rows.map((r) => {
        const e = entities.find((x) => x.id === r.legal_entity_id);
        return { legalEntityId: r.legal_entity_id, legalEntityName: e?.name ?? e?.registeredName ?? null, balance: money(r.v) };
      }),
      canManage: holds(auth, 'customers.manage'),
    };
  }
}
