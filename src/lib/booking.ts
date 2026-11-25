// The free times a booking link offers. Pure, shared by the server (the
// public booking page, and the check before a booking is stored) and the
// settings page's wording.

import { merge } from "./intervals";
import { DAY, MINUTE, addDays, dayKeyOf, dayStart, wallClock, weekday, zonedTime } from "./time";

/** A half-open [start, end) range in epoch ms. */
export type Span = { start: number; end: number };

/** A booking link's rules. Days and the daily window are on the host's clock. */
export type BookingRule = {
  durationMin: number;
  /** The weekdays it offers, 0 = Sunday. */
  days: number[];
  /** The daily window, in minutes after midnight. */
  startMin: number;
  endMin: number;
  /** Kept free before and after each time, from busy blocks and other bookings. */
  bufferMin: number;
  /** How long before a time it can be booked at the latest. */
  noticeMin: number;
  /** Today and the days after it, in all. */
  aheadDays: number;
  /** Bookings on this link per day; null for no cap. */
  maxPerDay: number | null;
};

export type SlotInput = {
  rule: BookingRule;
  /** The host's zone: the rule's days and hours are wall-clock times there. */
  zone: string;
  now: number;
  /** The end of the synced data: nothing is known after it. */
  until: number;
  /** The host's busy blocks. */
  busy: Span[];
  /** The host's active bookings on all their links; `here` when on this link. */
  booked: (Span & { here: boolean })[];
};

/** The lengths, breaks and notice times a link can have, in minutes. */
export const DURATIONS = [15, 30, 45, 60, 90, 120];
export const BUFFERS = [0, 5, 10, 15, 30];
export const NOTICES = [0, 60, 120, 240, 720, 1440, 2880];
/** The most bookings a link can take per day, when it has a cap. */
export const MAX_PER_DAY = 20;

/** "30 min", "1 hour", "1 h 30 min". */
export function lengthLabel(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : h === 1 ? "1 hour" : `${h} hours`;
}

/** Minutes between the times offered: 15 for a 15-minute meeting, else 30. */
export function slotStep(durationMin: number): number {
  return durationMin === 15 ? 15 : 30;
}

/** What a link offers: its free times, and the days it offers that have none left. */
export type OfferedTimes = {
  /** The free times, ascending. */
  slots: Span[];
  /**
   * The days it offers with no time free, each as the start of the first time
   * it would have offered that day, ascending. Nothing says why a day is full.
   */
  full: number[];
};

/**
 * The times the link offers, ascending. A time on day D (from today, in
 * `zone`, through aheadDays - 1 days later, on one of the rule's weekdays)
 * starts at the window's start on D's clock or a whole number of steps after
 * it, and ends, durationMin later, by the window's end. It starts no sooner
 * than the notice allows and ends by `until`. With the buffer around it, it
 * overlaps no busy block and no booking; touching doesn't count. A day that
 * has maxPerDay bookings on this link offers nothing.
 */
export function bookableSlots(input: SlotInput): Span[] {
  return offeredTimes(input).slots;
}

/**
 * bookableSlots' times, and the days that are full. A day is offered when it
 * has at least one time the window, the clock, the notice and `until` allow;
 * it's full when none of those times is free: the day has maxPerDay bookings
 * on this link, or every one of them is busy or booked. Other days (another
 * weekday, past aheadDays, or today once the notice has passed its last time)
 * are neither.
 */
export function offeredTimes({ rule, zone, now, until, busy, booked }: SlotInput): OfferedTimes {
  const length = rule.durationMin * MINUTE;
  const pad = rule.bufferMin * MINUTE;
  const earliest = now + rule.noticeMin * MINUTE;
  const step = slotStep(rule.durationMin);
  const taken = merge([...busy, ...booked].map((b): [number, number] => [b.start, b.end]));

  const perDay = new Map<string, number>();
  for (const b of booked) {
    if (!b.here) continue;
    const day = dayKeyOf(b.start, zone);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const slots: Span[] = [];
  const full: number[] = [];
  const today = dayKeyOf(now, zone);
  for (let i = 0; i < rule.aheadDays; i++) {
    const day = addDays(today, i);
    if (!rule.days.includes(weekday(day))) continue;
    const capped = rule.maxPerDay !== null && (perDay.get(day) ?? 0) >= rule.maxPerDay;
    // A day of 24 hours has no clock change: its times are minutes after its
    // midnight. Only the day the clocks change needs each time looked up.
    const midnight = dayStart(day, zone);
    const plain = dayStart(addDays(day, 1), zone) - midnight === DAY;
    const close = plain ? midnight + rule.endMin * MINUTE : zonedTime(day, rule.endMin / 60, zone);
    /** The day's first time, free or not, and whether any of its times is free. */
    let first: number | null = null;
    let free = false;
    for (let m = rule.startMin; m < rule.endMin; m += step) {
      const start = plain ? midnight + m * MINUTE : zonedTime(day, m / 60, zone);
      // A time the clocks skip when daylight saving starts isn't on D's clock.
      if (!plain && !showsOnClock(start, day, m, zone)) continue;
      const end = start + length;
      if (end > close || start < earliest || end > until) continue;
      first ??= start;
      if (capped || overlapsAny(taken, start - pad, end + pad)) continue;
      slots.push({ start, end });
      free = true;
    }
    if (first !== null && !free) full.push(first);
  }
  return { slots, full };
}

/**
 * What a try the limit per address refused says: the wait in whole minutes,
 * rounded up, so it's never shorter than it is. "Too many tries. Try again in
 * 7 minutes."
 */
export function tryAgainIn(waitMs: number): string {
  const minutes = Math.max(1, Math.ceil(waitMs / MINUTE));
  return `Too many tries. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** Whether `epoch` reads `minutes` after midnight on `day`, in `zone`. */
function showsOnClock(epoch: number, day: string, minutes: number, zone: string): boolean {
  const c = wallClock(epoch, zone);
  return c.day === day && c.hour * 60 + c.minute === minutes;
}

/** Whether [from, to) overlaps any of `merged`: sorted, apart, half-open. */
function overlapsAny(merged: [number, number][], from: number, to: number): boolean {
  // The first range that ends after `from`.
  let lo = 0;
  let hi = merged.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid][1] > from) hi = mid;
    else lo = mid + 1;
  }
  return lo < merged.length && merged[lo][0] < to;
}
