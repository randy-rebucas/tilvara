import type { PoolClient } from 'pg';

/**
 * The reminder email for an appointment flagged by `platform_flag_appointment_reminders()` (ADR-0022
 * §10), read in the event's tenant: null when it no longer applies (cancelled, moved to another time
 * and not due yet, reminder turned off, or the customer has no email or was anonymised since).
 * Staff are named by first name only; the time is in the branch's calendar.
 */
export async function appointmentReminderMail(client: PoolClient, payload: Record<string, unknown>): Promise<{ to: string; subject: string; text: string } | null> {
  const { rows: [a] } = await client.query<{ email: string | null; customer: string; branch: string; address: string | null; tz: string; when: string; status: string; remind: boolean; anonymised: boolean }>(
    `SELECT c.email, c.display_name AS customer, b.name AS branch, b.address, b.timezone AS tz, a.status, a.remind, c.anonymised_at IS NOT NULL AS anonymised,
            to_char(a.starts_at AT TIME ZONE b.timezone, 'FMDay, FMMonth FMDD "at" FMHH12:MI AM') AS when
       FROM appointments a
       JOIN branches b ON b.id = a.branch_id
       JOIN customers c ON c.id = a.customer_id
      WHERE a.id = $1 AND a.starts_at > now()`,
    [String(payload.appointmentId ?? '')],
  );
  if (!a || !a.email || a.anonymised || !a.remind || a.status !== 'BOOKED') return null;
  const { rows: services } = await client.query<{ name: string; staff: string }>(
    `SELECT concat_ws(' ', p.name, v.name) AS name, split_part(btrim(st.display_name), ' ', 1) AS staff
       FROM appointment_services s
       JOIN product_variants v ON v.id = s.variant_id
       JOIN products p ON p.id = v.product_id
       JOIN service_staff st ON st.id = s.staff_id
      WHERE s.appointment_id = $1 ORDER BY s.position`,
    [String(payload.appointmentId)],
  );
  const first = a.customer.trim().split(/\s+/)[0] ?? '';
  return {
    to: a.email,
    subject: `Reminder: your appointment at ${a.branch}, ${a.when}`,
    text: [
      `Hi ${first},`,
      '',
      `This is a reminder of your appointment at ${a.branch} on ${a.when}.`,
      ...services.map((s) => `- ${s.name} with ${s.staff}`),
      ...(a.address ? ['', a.address] : []),
      '',
      'If you cannot make it, please let us know so we can give the time to someone else.',
    ].join('\n'),
  };
}
