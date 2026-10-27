import type { PoolClient } from 'pg';

/**
 * Who hears about the business's bills (ADR-0027): active members holding `subscription.manage` for the
 * whole business (the owner role). Run inside the event's tenant (RLS).
 */
export async function billingContacts(client: PoolClient): Promise<{ email: string; name: string }[]> {
  const { rows } = await client.query<{ email: string; name: string }>(
    `SELECT DISTINCT u.email, u.display_name AS name
       FROM tenant_memberships m
       JOIN users u ON u.id = m.user_id AND u.status = 'ACTIVE'
       JOIN membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id AND mr.scope_type = 'TENANT'
       JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.archived_at IS NULL
       JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
      WHERE m.status = 'ACTIVE' AND rp.permission_code = 'subscription.manage'
      ORDER BY u.email`,
  );
  return rows;
}

const planName = (code: string): string => code.charAt(0).toUpperCase() + code.slice(1);

/** The plan limits (`PlanLimits` keys), as the downgrade mail says them. */
const LIMIT_WORDS: Record<string, string> = {
  maxLegalEntities: 'more legal entities',
  maxBranches: 'more branches',
  maxRegisters: 'more registers',
  maxUsers: 'more members',
};

/**
 * The mail for a billing event (`billing.bill_issued`, `billing.reminder` three days and one day before the
 * due date, `billing.past_due`, `billing.canceled`), or null when there is nothing left to say (the bill was
 * paid or voided since). Dates in Philippine time; amounts include 12% VAT.
 */
export async function billingMail(client: PoolClient, topic: string, payload: Record<string, unknown>): Promise<{ subject: string; text: string } | null> {
  if (topic === 'billing.receipt_issued') {
    const { rows: [r] } = await client.query<{
      number: string; issued: string; seller: Record<string, string | boolean | null>; buyer: Record<string, string | null>; description: string;
      amount: string; vatable: string; vat: string; currency: string; method: string; reference: string;
    }>(
      `SELECT number, to_char(issued_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS issued, seller, buyer, description,
              amount::numeric(20,2)::text AS amount, vatable_amount::numeric(20,2)::text AS vatable, vat_amount::numeric(20,2)::text AS vat,
              currency, method, reference
         FROM billing_receipts WHERE id = $1`,
      [String(payload.receiptId ?? '')],
    );
    if (!r) return null;
    const line = (label: string, value: unknown) => (value ? [`${label}: ${String(value)}`] : []);
    const seller = r.seller;
    const buyer = r.buyer;
    return {
      subject: `Tilvara receipt ${r.number}: ${r.currency} ${r.amount} received`,
      text: [
        `RECEIPT ${r.number}`,
        `Date: ${r.issued}`,
        '',
        String(seller.registeredName ?? 'Tilvara'),
        ...line('Trade name', seller.tradeName),
        ...line(seller.vatRegistered ? 'VAT Reg. TIN' : 'TIN', seller.tin),
        ...line('Address', seller.address),
        '',
        `Received from: ${buyer.registeredName ?? buyer.businessName ?? ''}`,
        ...line('Business', buyer.registeredName && buyer.businessName !== buyer.registeredName ? buyer.businessName : null),
        ...line('TIN', buyer.tin),
        ...line('Address', buyer.address),
        '',
        r.description,
        ...(seller.vatRegistered ? [`VATable sales: ${r.currency} ${r.vatable}`, `VAT (12%): ${r.currency} ${r.vat}`] : []),
        `Total: ${r.currency} ${r.amount}`,
        `Paid by ${r.method.replace(/_/g, ' ').toLowerCase()}, reference ${r.reference}`,
        '',
        'System-generated receipt. A copy is kept in the back office: Subscription → Plan → Bills.',
        ...(seller.permitNote ? [String(seller.permitNote)] : []),
      ].join('\n'),
    };
  }
  if (topic === 'billing.bill_issued' || topic === 'billing.reminder') {
    const { rows: [b] } = await client.query<{ number: string; kind: string; plan_code: string; amount: string; vat: string; currency: string; status: string; due: string; period_start: string; period_end: string }>(
      `SELECT number, kind, plan_code, amount::numeric(20,2)::text AS amount, vat_amount::numeric(20,2)::text AS vat, currency, status,
              (due_at AT TIME ZONE 'Asia/Manila')::date::text AS due,
              (period_start AT TIME ZONE 'Asia/Manila')::date::text AS period_start,
              (period_end AT TIME ZONE 'Asia/Manila')::date::text AS period_end
         FROM billing_bills WHERE id = $1`,
      [String(payload.billId ?? '')],
    );
    if (!b || b.status !== 'OPEN') return null;
    const what = b.kind === 'UPGRADE' ? `the move to the ${planName(b.plan_code)} plan until ${b.period_end}` : `the ${planName(b.plan_code)} plan, ${b.period_start} to ${b.period_end}`;
    const total = `${b.currency} ${b.amount} (VAT included: ${b.currency} ${b.vat})`;
    const pay = 'Pay it in the back office: Subscription → Plan → Pay. Pay the full amount: a part payment does not settle a bill. The receipt is emailed once it is paid.';
    if (topic === 'billing.reminder') {
      const when = payload.when === 'LAST' ? 'tomorrow' : `on ${b.due}`;
      return {
        subject: `Reminder: Tilvara bill ${b.number} is due ${when}`,
        text: `Bill ${b.number} for ${what}, ${total}, is due ${payload.when === 'LAST' ? `tomorrow (${b.due})` : `on ${b.due}`}. ${pay}`,
      };
    }
    return {
      subject: `Tilvara bill ${b.number}: ${b.currency} ${b.amount}`,
      text: `Bill ${b.number} for ${what} is ${total}, due ${b.due}. ${pay}`,
    };
  }
  const { rows: [s] } = await client.query<{ status: string; grace: string | null }>(
    `SELECT status, (grace_ends_at AT TIME ZONE 'Asia/Manila')::date::text AS grace FROM subscriptions`,
  );
  if (topic === 'billing.past_due') {
    if (!s || s.status !== 'PAST_DUE') return null;
    return {
      subject: 'Your Tilvara subscription is past due',
      text: `The paid period has ended and the bill is unpaid. Everything keeps working until ${s.grace ?? 'the end of the grace period'}; after that your records stay readable but nothing new can be recorded. Pay it in the back office: Subscription → Plan → Pay.`,
    };
  }
  if (topic === 'billing.downgrade_dropped') {
    // The renewal was billed on the current plan instead (audit 45 #17); payload: { plan, limit } (codes only).
    const plan = typeof payload.plan === 'string' ? planName(payload.plan) : 'the cheaper';
    const what = LIMIT_WORDS[String(payload.limit ?? '')] ?? 'more';
    return {
      subject: `Your Tilvara plan stays the same: the business no longer fits ${plan}`,
      text: `You chose to move to the ${plan} plan at renewal. The business now has ${what} than that plan allows, so the renewal is on your current plan and the move was dropped. To move later, archive what is over the limit, then choose the plan again in the back office: Subscription → Plan.`,
    };
  }
  if (topic === 'billing.canceled') {
    if (!s || s.status !== 'CANCELED') return null;
    return {
      subject: 'Your Tilvara subscription has ended',
      text: 'As you asked, the subscription ended with its paid period. Your records stay readable, and you can export them. To start again, choose a plan in the back office: Subscription → Plan.',
    };
  }
  return null;
}
