import { describe, expect, it } from 'vitest';
import { addDays, dateLabel, hhmmOf, minutesOf, weekdayOf, zonedDay, zonedInstant, zonedMinutes } from './calendar';

describe('branch calendar', () => {
  it('turns a Manila wall-clock time into its instant and back', () => {
    const at = zonedInstant('2026-10-21', '09:30', 'Asia/Manila');
    expect(at.toISOString()).toBe('2026-10-21T01:30:00.000Z');
    expect(zonedDay(at, 'Asia/Manila')).toBe('2026-10-21');
    expect(zonedMinutes(at, 'Asia/Manila')).toBe(570);
  });

  it('puts an instant on the branch day, not the till day', () => {
    expect(zonedDay('2026-10-20T17:00:00.000Z', 'Asia/Manila')).toBe('2026-10-21');
  });

  it('follows daylight saving where a zone has it', () => {
    expect(zonedInstant('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedInstant('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z');
  });

  it('moves days and knows the weekday (Sunday = 0)', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(weekdayOf('2026-10-25')).toBe(0);
    expect(minutesOf('13:45')).toBe(825);
    expect(hhmmOf(825)).toBe('13:45');
  });

  it('reads a calendar day the same whatever the till’s zone', () => {
    expect(dateLabel('2026-10-21')).toMatch(/Oct 21, 2026|21 Oct 2026/);
  });
});
