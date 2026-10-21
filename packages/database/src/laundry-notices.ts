import type { PoolClient } from 'pg';

/** One queued laundry notice (ADR-0024 §6), ready for the worker's channels; null when there is nothing to send. */
export interface LaundryNotice {
  noticeId: string;
  kind: 'READY' | 'REMINDER' | 'FINAL';
  /** Why nothing goes out (claimed meanwhile, notices off, no address): the notice is settled SKIPPED. */
  skip: string | null;
  email: { to: string; subject: string; text: string } | null;
  sms: { to: string; text: string } | null;
}

/**
 * Build a queued notice's messages, inside the event's tenant (RLS). Ids only came in the event; names
 * and addresses are read here and never logged. A READY notice goes while the job is ready or out for
 * delivery; reminders and the final notice only while it waits at the shop. No items, no claim code.
 */
export async function laundryNotice(client: PoolClient, payload: Record<string, unknown>): Promise<LaundryNotice | null> {
  const { rows: [n] } = await client.query<{
    id: string; kind: LaundryNotice['kind']; status: string; job_status: string; notify: boolean; number: string; business: string; branch: string;
    email: string | null; phone: string | null; anonymised: boolean; sms_enabled: boolean; balance: string; ready_on: string | null; dispose_on: string | null;
  }>(
    `SELECT n.id, n.kind, n.status, j.status AS job_status, j.notify, j.number::text AS number,
            coalesce(e.trade_name, t.name) AS business, b.name AS branch,
            c.email, coalesce(j.customer_phone, c.phone) AS phone, c.anonymised_at IS NOT NULL AS anonymised,
            coalesce(s.sms_enabled, false) AS sms_enabled,
            to_char(greatest(j.amount_due - coalesce((SELECT sum(d.amount) FROM job_order_deposits d WHERE d.job_order_id = j.id), 0), 0), 'FM999,999,999,990.00') AS balance,
            to_char(j.ready_at AT TIME ZONE b.timezone, 'FMMonth FMDD') AS ready_on,
            to_char((j.ready_at + make_interval(days => coalesce(s.unclaimed_days, 30))) AT TIME ZONE b.timezone, 'FMMonth FMDD, YYYY') AS dispose_on
       FROM job_order_notices n
       JOIN job_orders j ON j.id = n.job_order_id
       JOIN branches b ON b.id = j.branch_id
       JOIN legal_entities e ON e.id = j.legal_entity_id
       JOIN tenants t ON t.id = j.tenant_id
       LEFT JOIN customers c ON c.id = j.customer_id
       LEFT JOIN laundry_settings s ON s.branch_id = j.branch_id
      WHERE n.id = $1`,
    [String(payload.noticeId ?? '')],
  );
  if (!n || n.status !== 'QUEUED') return null;
  const ref = `J-${n.number.padStart(6, '0')}`;
  const stillDue = n.kind === 'READY' ? ['READY', 'OUT_FOR_DELIVERY'].includes(n.job_status) : n.job_status === 'READY';
  const skip = !stillDue ? 'NO_LONGER_DUE' : !n.notify ? 'NOTICES_OFF' : null;
  const pay = n.balance !== '0.00' ? ` Balance ₱${n.balance}.` : ' Fully paid.';
  const text =
    n.kind === 'READY'
      ? `${n.business}: your laundry ${ref} is ready for pickup at ${n.branch}.${pay} Please bring your claim stub.`
      : n.kind === 'REMINDER'
        ? `${n.business}: a reminder that your laundry ${ref} has been ready for pickup at ${n.branch} since ${n.ready_on}.${pay}`
        : `${n.business}: your laundry ${ref} has been waiting at ${n.branch} since ${n.ready_on}. Please claim it by ${n.dispose_on}; after that it is handled under our claim policy.${pay}`;
  const subject = n.kind === 'READY' ? `Your laundry ${ref} is ready` : n.kind === 'REMINDER' ? `Reminder: your laundry ${ref} is ready` : `Last notice: please claim your laundry ${ref}`;
  const email = n.email && !n.anonymised ? { to: n.email, subject, text } : null;
  const sms = n.phone && n.sms_enabled ? { to: n.phone, text } : null;
  return { noticeId: n.id, kind: n.kind, skip: skip ?? (!email && !sms ? 'NO_CHANNEL' : null), email, sms };
}
