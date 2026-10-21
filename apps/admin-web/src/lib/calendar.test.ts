import { describe, expect, it } from 'vitest';
import { addDays, dayWindow, fromMinutes, localParts, mondayOf, toMinutes, weekdayOf, zonedInstant } from './calendar';

describe('appointment calendar arithmetic', () => {
  it('turns a Manila date and time into an instant and back', () => {
    expect(zonedInstant('2026-10-21', '09:30', 'Asia/Manila')).toBe('2026-10-21T01:30:00.000Z');
    expect(zonedInstant('2026-10-21', '00:15', 'Asia/Manila')).toBe('2026-10-20T16:15:00.000Z');
    expect(localParts('2026-10-20T16:15:00.000Z', 'Asia/Manila')).toEqual({ date: '2026-10-21', time: '00:15', minutes: 15 });
    expect(localParts('2026-10-21T10:00:00Z', 'Asia/Manila').time).toBe('18:00');
  });

  it('counts days and weekdays on the calendar itself', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-10-25')).toBe(0); // a Sunday
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
    expect(mondayOf('2026-10-19')).toBe('2026-10-19');
  });

  it('shows at least 09:00–18:00, widened to whole hours around the day', () => {
    expect(dayWindow([])).toEqual({ start: 540, end: 1080 });
    expect(dayWindow([{ start: toMinutes('07:45'), end: toMinutes('20:10') }])).toEqual({ start: 420, end: 1260 });
    expect(fromMinutes(570)).toBe('09:30');
  });
});
