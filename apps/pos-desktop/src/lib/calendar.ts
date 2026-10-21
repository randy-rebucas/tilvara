/**
 * Days and times in the branch's calendar (its IANA time zone), for the appointment book (ADR-0022).
 * The till's own clock and zone never decide which day an appointment is on.
 */

/** How far the zone is ahead of UTC at an instant, in ms (from Intl, so daylight saving is followed). */
function offsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant of a wall-clock time ('YYYY-MM-DD', 'HH:MM') in the zone. */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Twice: the offset at the guessed instant may differ from the offset at the answer (a DST change).
  const first = wall - offsetMs(wall, timeZone);
  return new Date(wall - offsetMs(first, timeZone));
}

/** The day ('YYYY-MM-DD') an instant falls on in the zone. */
export function zonedDay(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

/** Minutes since midnight of an instant in the zone. */
export function zonedMinutes(at: Date | string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

/** A time of day at the branch, "14:30". */
export const clockTime = (at: Date | string, timeZone: string) =>
  new Intl.DateTimeFormat('en-PH', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));

/** 'YYYY-MM-DD' moved by whole days (calendar arithmetic, no zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Weekday of a calendar day, 0 = Sunday (as staff hours are kept). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 'HH:MM' → minutes since midnight. */
export const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Minutes since midnight → 'HH:MM'. */
export const hhmmOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** A calendar day ('YYYY-MM-DD') as people read it, e.g. "Oct 21, 2026" (no zone: the day is already local). */
export const dateLabel = (d: string) => new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`));
