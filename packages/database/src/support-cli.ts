import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import pg from 'pg';

const USAGE = `Tilvara support tool. Connects with ops credentials (DATABASE_MIGRATOR_URL), never the runtime role.

  support mfa-reset --email <owner email> --reason "<how identity was checked>" --ticket <ref> [--actor <name>]
      Clears the two-step sign-in of an owner who lost both their phone and their recovery codes.
      Members other than the owner are reset by an owner or admin on the member's page instead.
      Follow docs/operations/support-mfa-reset.md: verify identity first; every reset is audited.

  support account-disable --email <email> --reason "<why>" --ticket <ref> [--actor <name>]
      Blocks sign-in and ends every session of an account at its next request: a compromised
      account (security-incident.md 2.1) or a data subject's erasure/objection request
      (privacy/data-subject-requests.md). Audited as platform.user.disabled.

  support account-enable --email <email> --reason "<how identity was checked>" --ticket <ref> [--actor <name>]
      Lets a disabled or closed account sign in again (sessions stay ended). Audited.

  support subscription-show --slug <business address>
      The business's plan, status, dates and whether it may write now.

  support subscription-set --slug <business address> --plan <starter|growth|enterprise> --status <TRIALING|ACTIVE|PAST_DUE|CANCELED>
      [--trial-ends <date>] [--paid-until <date>] [--grace-ends <date>] --reason "<why>" --ticket <ref> [--actor <name>]
      Changes a business's plan or status by hand (billing does it by itself, ADR-0027): extend a trial (TRIALING
      --trial-ends), record a payment (ACTIVE --paid-until), past due (PAST_DUE --grace-ends) or end it
      (CANCELED: read-only, nothing deleted). Dates are ISO (2026-11-30 or 2026-11-30T23:59+08:00) and in
      the future. Written in the business's own audit log as subscription.changed. tenant-offboarding.md.

  support billing-bills --slug <business address>
      The business's bills (newest first) with what was received for each.

  support billing-payment --slug <business address> --bill <B-000001> --amount <999.00> --method <BANK_TRANSFER|GCASH|MAYA|CARD|QRPH|GRABPAY|CASH|OTHER>
      --reference "<bank or wallet reference>" --received <date> --reason "<how it was checked>" --ticket <ref> [--actor <name>]
      Records money received outside the payment page (a bank transfer, a GCash send). The exact amount
      of an open bill settles it and the subscription follows (docs/operations/billing.md); any other
      amount (no part payments), or a bill already paid or voided, is kept unapplied for a refund. Audited.

  support billing-void --slug <business address> --bill <B-000001> --reason "<why>" --ticket <ref> [--actor <name>]
      Voids an open bill (issued by mistake, waived). Audited.

  support billing-seller [--name "<registered name>" --tin <123-456-789-00000> --address "<registered address>"
      [--trade-name "<trade name>"] [--vat-registered true|false] [--permit "<BIR permit line>"] --reason "<why>"] [--actor <name>]
      Without --name: prints Tilvara's details as receipts show them. With it: sets them for receipts from now on
      (receipts already issued keep theirs). Audited as a platform event.

  support plan-price --plan <starter|growth|enterprise> --amount <999.00> --reason "<why>" [--actor <name>]
      Sets a plan's monthly price (PHP, 12% VAT included). A plan priced 0 is never billed. Bills already issued keep
      their amount. Audited as a platform event.

  support staff-add --email <staff email> --reason "<why>" [--actor <name>]
  support staff-disable --email <staff email> --reason "<why>" [--actor <name>]
  support staff-list
      Tilvara support staff (docs/operations/support-access.md). Staff see a business only while that
      business has given support access; the account must already use two-step sign-in.`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      reason: { type: 'string' },
      ticket: { type: 'string' },
      slug: { type: 'string' },
      plan: { type: 'string' },
      status: { type: 'string' },
      'trial-ends': { type: 'string' },
      'paid-until': { type: 'string' },
      'grace-ends': { type: 'string' },
      bill: { type: 'string' },
      amount: { type: 'string' },
      method: { type: 'string' },
      reference: { type: 'string' },
      received: { type: 'string' },
      name: { type: 'string' },
      tin: { type: 'string' },
      address: { type: 'string' },
      'trade-name': { type: 'string' },
      'vat-registered': { type: 'string' },
      permit: { type: 'string' },
      actor: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command] = positionals;
  const commands = ['mfa-reset', 'account-disable', 'account-enable', 'staff-add', 'staff-disable', 'staff-list', 'subscription-show', 'subscription-set', 'billing-bills', 'billing-payment', 'billing-void', 'plan-price', 'billing-seller'];
  if (values.help || !command || !commands.includes(command)) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const needed: readonly (keyof typeof values)[] =
    ['mfa-reset', 'account-disable', 'account-enable'].includes(command) ? ['email', 'reason', 'ticket']
      : command === 'staff-list' ? []
      : command === 'subscription-show' || command === 'billing-bills' ? ['slug']
      : command === 'billing-payment' ? ['slug', 'bill', 'amount', 'method', 'reference', 'received', 'reason', 'ticket']
      : command === 'billing-void' ? ['slug', 'bill', 'reason', 'ticket']
      : command === 'plan-price' ? ['plan', 'amount', 'reason']
      : command === 'billing-seller' ? (values.name ? ['name', 'reason'] : [])
      : command === 'subscription-set' ? ['slug', 'plan', 'status', 'reason', 'ticket']
      : ['email', 'reason'];
  const missing = needed.filter((k) => typeof values[k] !== 'string' || (values[k] as string).trim().length < (k === 'amount' ? 1 : 3));
  if (missing.length) {
    console.error(`${command} needs ${missing.map((m) => `--${m}`).join(', ')} (recorded in the audit log)`);
    return 2;
  }
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) {
    console.error('DATABASE_MIGRATOR_URL is not set');
    return 2;
  }
  const actor = values.actor ?? userInfo().username;
  if (values.amount !== undefined && !/^\d{1,12}(\.\d{1,2})?$/.test(values.amount)) {
    console.error(`--amount is not an amount in pesos (999 or 999.50): ${values.amount}`);
    return 2;
  }
  const dates: Record<'trial-ends' | 'paid-until' | 'grace-ends' | 'received', Date | null> = { 'trial-ends': null, 'paid-until': null, 'grace-ends': null, received: null };
  for (const k of Object.keys(dates) as (keyof typeof dates)[]) {
    const v = values[k];
    if (v === undefined) continue;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) {
      console.error(`--${k} is not a date: ${v}`);
      return 2;
    }
    dates[k] = d;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    switch (command) {
      case 'mfa-reset': {
        const { rows } = await pool.query<{ v: string | null }>('SELECT auth_mfa_support_reset($1, $2, $3, $4) AS v', [values.email, actor, values.reason, values.ticket]);
        if (!rows[0]!.v) {
          console.error('Nothing reset: no active account with that email uses two-step sign-in.');
          return 1;
        }
        console.log(`Reset two-step sign-in for user ${rows[0]!.v}. Their sessions ended; they set it up again at the next sign-in.`);
        return 0;
      }
      case 'account-disable':
      case 'account-enable': {
        const fn = command === 'account-disable' ? 'platform_account_disable' : 'platform_account_enable';
        const { rows } = await pool.query<{ v: string | null }>(`SELECT ${fn}($1, $2, $3, $4) AS v`, [values.email, actor, values.reason, values.ticket]);
        if (!rows[0]!.v) {
          console.error(`Nothing changed: no ${command === 'account-disable' ? 'active' : 'disabled'} account with that email.`);
          return 1;
        }
        console.log(
          command === 'account-disable'
            ? `Account ${rows[0]!.v} disabled; its sessions end at their next request.`
            : `Account ${rows[0]!.v} can sign in again. Its old sessions stay ended.`,
        );
        return 0;
      }
      case 'staff-add': {
        const { rows } = await pool.query<{ v: string }>('SELECT support_staff_add($1, $2, $3) AS v', [values.email, actor, values.reason]);
        console.log(`Support staff ${rows[0]!.v} is active. They see a business only while it gives support access.`);
        return 0;
      }
      case 'staff-disable': {
        const { rows } = await pool.query<{ v: string | null }>('SELECT support_staff_disable($1, $2, $3) AS v', [values.email, actor, values.reason]);
        if (!rows[0]!.v) {
          console.error('Nothing changed: no active support staff with that email.');
          return 1;
        }
        console.log(`Support staff ${rows[0]!.v} disabled; any support session they hold stops at its next request.`);
        return 0;
      }
      case 'subscription-show':
        return (await showSubscription(pool, values.slug!)) ? 0 : 1;
      case 'subscription-set': {
        await pool.query('SELECT platform_change_subscription($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
          values.slug, values.plan, values.status?.toUpperCase(), dates['trial-ends'], dates['paid-until'], dates['grace-ends'], actor, values.reason, values.ticket,
        ]);
        console.log('Changed. The business sees it at its next page; written in its audit log as subscription.changed.');
        await showSubscription(pool, values.slug!);
        return 0;
      }
      case 'billing-bills':
        return (await showBills(pool, values.slug!)) ? 0 : 1;
      case 'billing-payment': {
        const { rows } = await pool.query<{ v: string }>('SELECT platform_billing_record_payment($1, $2, $3, $4, $5, $6, $7, $8, $9) AS v', [
          values.slug, values.bill, values.amount, values.method?.toUpperCase(), values.reference, dates.received, actor, values.reason, values.ticket,
        ]);
        const outcome = rows[0]!.v;
        console.log(
          outcome === 'APPLIED' ? 'Recorded and applied: the bill is paid and the subscription follows it.'
            : outcome === 'DUPLICATE' ? 'Already recorded (same reference): nothing changed.'
            : 'Recorded but NOT applied (the bill is not open, or the amount differs): refund it or ask the business. See docs/operations/billing.md.',
        );
        await showSubscription(pool, values.slug!);
        return outcome === 'UNAPPLIED' ? 1 : 0;
      }
      case 'billing-void':
        await pool.query('SELECT platform_billing_void_bill($1, $2, $3, $4, $5)', [values.slug, values.bill, actor, values.reason, values.ticket]);
        console.log(`Bill ${values.bill!.toUpperCase()} voided; written in the business's audit log.`);
        return 0;
      case 'billing-seller': {
        if (values.name) {
          await pool.query('SELECT platform_set_billing_seller($1, $2, $3, $4, $5, $6, $7, $8)', [
            values.name, values['trade-name'] ?? null, values.tin ?? null, values.address ?? null,
            values['vat-registered'] === undefined ? true : values['vat-registered'] === 'true', values.permit ?? null, actor, values.reason,
          ]);
          console.log('Saved. Receipts from now on show these details; receipts already issued keep theirs.');
        }
        const { rows: [s] } = await pool.query<{ registered_name: string; trade_name: string | null; tin: string | null; address: string | null; vat_registered: boolean; permit_note: string | null }>(
          'SELECT * FROM platform_billing_seller()',
        );
        console.log(`${s?.registered_name ?? '—'}${s?.trade_name ? ` (${s.trade_name})` : ''}`);
        console.log(`  TIN ${s?.tin ?? '— (not set)'} · ${s?.vat_registered ? 'VAT-registered' : 'not VAT-registered'}`);
        console.log(`  ${s?.address ?? 'address not set'}`);
        if (s?.permit_note) console.log(`  ${s.permit_note}`);
        return 0;
      }
      case 'plan-price':
        await pool.query('SELECT platform_set_plan_price($1, $2, $3, $4)', [values.plan, values.amount, actor, values.reason]);
        console.log(`Plan ${values.plan} now costs PHP ${values.amount} a month; bills already issued keep their amount.`);
        return 0;
      default: {
        const { rows } = await pool.query<{ email: string; display_name: string; status: string; added_at: Date; added_by: string }>('SELECT * FROM support_staff_list()');
        for (const r of rows) console.log(`${r.status.padEnd(8)} ${r.email}  (${r.display_name}; added ${r.added_at.toISOString().slice(0, 10)} by ${r.added_by})`);
        if (rows.length === 0) console.log('No support staff.');
        return 0;
      }
    }
  } finally {
    await pool.end();
  }
}

async function showSubscription(pool: pg.Pool, slug: string): Promise<boolean> {
  const { rows } = await pool.query<{
    tenant_id: string; tenant_name: string; tenant_status: string; plan_code: string | null; status: string | null;
    trial_ends_at: Date | null; current_period_end: Date | null; grace_ends_at: Date | null; writable: boolean;
  }>('SELECT * FROM platform_subscription_of($1)', [slug]);
  const r = rows[0];
  if (!r) {
    console.error(`No business with the address ${slug}.`);
    return false;
  }
  const day = (d: Date | null) => (d ? d.toISOString() : '—');
  console.log(`${r.tenant_name} (${r.tenant_id}), business ${r.tenant_status}`);
  console.log(`  plan ${r.plan_code ?? '—'} · ${r.status ?? 'no subscription'} · ${r.writable && r.tenant_status === 'ACTIVE' ? 'full access' : 'read-only'}`);
  console.log(`  trial ends ${day(r.trial_ends_at)} · paid until ${day(r.current_period_end)} · grace ends ${day(r.grace_ends_at)}`);
  return true;
}

async function showBills(pool: pg.Pool, slug: string): Promise<boolean> {
  if (!(await showSubscription(pool, slug))) return false;
  const { rows } = await pool.query<{
    number: string; kind: string; plan_code: string; period_start: Date; period_end: Date; amount: string; vat_amount: string; currency: string; status: string;
    due_at: Date; paid_at: Date | null; received: string; unapplied: string;
  }>('SELECT * FROM platform_billing_bills($1)', [slug]);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  for (const b of rows) {
    console.log(
      `  ${b.number} ${b.kind.padEnd(7)} ${b.plan_code.padEnd(10)} ${day(b.period_start)}..${day(b.period_end)} ${b.currency} ${b.amount.padStart(12)} (VAT ${b.vat_amount}) ${b.status.padEnd(4)}` +
        ` due ${day(b.due_at)}${b.paid_at ? ` paid ${day(b.paid_at)}` : ''}${/[1-9]/.test(b.unapplied) ? `  UNAPPLIED ${b.unapplied}` : ''}`,
    );
  }
  if (rows.length === 0) console.log('  No bills.');
  return true;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
