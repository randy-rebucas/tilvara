/**
 * Calendar arithmetic for appointments (ADR-0022): a branch keeps its calendar in its own time zone
 * (`branches.timezone`, Asia/Manila in practice). Dates are plain YYYY-MM-DD, times HH:MM; instants
 * go to the API as ISO strings. Whole minutes only: no money or quantities here.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Minutes the zone is ahead of UTC at this instant (+480 for Manila). */
export function zoneOffsetMinutes(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** The instant of a local date and time in the zone, as an ISO string. */
export function zonedInstant(date: string, time: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, h!, mi!);
  let utc = guess - zoneOffsetMinutes(timeZone, guess) * 60_000;
  // Across a change of offset (not in the Philippines), the second look settles it.
  utc = guess - zoneOffsetMinutes(timeZone, utc) * 60_000;
  return new Date(utc).toISOString();
}

/** The local date (YYYY-MM-DD), time (HH:MM) and minute of the day of an instant in the zone. */
export function localParts(iso: string, timeZone: string): { date: string; time: string; minutes: number } {
  const ms = Date.parse(iso);
  const local = new Date(ms + zoneOffsetMinutes(timeZone, ms) * 60_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
    minutes,
  };
}

/** A date `days` later (or earlier), on the calendar itself (no time zone). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday, as the API numbers weekdays. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** The Monday on or before the date (a week view starts on Monday, like the report presets). */
export function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** "HH:MM" → minutes after midnight. */
export const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h! * 60 + m!;
};

/** Minutes after midnight → "HH:MM". */
export const fromMinutes = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export const isDate = (s: string | undefined | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isTime = (s: string | undefined | null): s is string => !!s && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/**
 * The hours a day view shows: the earliest start and latest end of the staff's hours and of the
 * day's bookings, widened to whole hours, and never less than 09:00–18:00.
 */
export function dayWindow(spans: { start: number; end: number }[]): { start: number; end: number } {
  const start = Math.min(9 * 60, ...spans.map((s) => s.start));
  const end = Math.max(18 * 60, ...spans.map((s) => s.end));
  return { start: Math.max(0, Math.floor(start / 60) * 60), end: Math.min(24 * 60, Math.ceil(end / 60) * 60) };
}

/** Appointment states, in the order the calendar's legend lists them. */
export const APPOINTMENT_STATUSES = ['BOOKED', 'ARRIVED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
/** Still to happen: can be changed, marked arrived or no-show, cancelled, or rung up at the till. */
export const isOpen = (status: string) => status === 'BOOKED' || status === 'ARRIVED';

/** Calendar colours to start from (any colour can be picked); the next unused one is suggested. */
export const STAFF_COLOURS = ['#7a4cc2', '#2a8a8a', '#c2577a', '#b8862a', '#4c7ac2', '#5a8a3a', '#c26a3a', '#6b6f78'];
