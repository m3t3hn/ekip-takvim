// The booking links' free-time rule (criterion 3), stated again from the
// criteria, one candidate at a time, with the wall clock read from Intl. It
// shares no code with src/lib/booking.ts, so the two can be compared.
//
// A wall-clock time can exist once, not at all (the clock skips it) or twice
// (the clock repeats it). Where the criteria leave room on such a day, the
// reference gives two answers:
// - `must`: times every reading of the criteria offers;
// - `may`: times some reading offers.
// On a day without a clock change the two are the same.

export type Span = { start: number; end: number };
export type Rule = {
  durationMin: number;
  days: number[];
  startMin: number;
  endMin: number;
  bufferMin: number;
  noticeMin: number;
  aheadDays: number;
  maxPerDay: number | null;
};
export type SlotsInput = {
  rule: Rule;
  zone: string;
  now: number;
  until: number;
  busy: Span[];
  booked: (Span & { here: boolean })[];
};

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** A calendar date: year, month 1-12, day. */
export type Day = { y: number; m: number; d: number };
export type Wall = Day & { minute: number; weekday: number };

const formats = new Map<string, Intl.DateTimeFormat>();
function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(zone, f);
  }
  return f;
}

const walls = new Map<string, Map<number, Wall>>();

/** The wall clock in `zone` at instant `t`. */
export function wall(t: number, zone: string): Wall {
  let seen = walls.get(zone);
  if (!seen) walls.set(zone, (seen = new Map()));
  const known = seen.get(t);
  if (known) return known;
  const p: Record<string, string> = {};
  for (const part of format(zone).formatToParts(t)) p[part.type] = part.value;
  const y = Number(p.year);
  const m = Number(p.month);
  const d = Number(p.day);
  const out = { y, m, d, minute: Number(p.hour) * 60 + Number(p.minute), weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
  seen.set(t, out);
  return out;
}

/** Minutes on a count that runs with the wall clock: equal for equal wall-clock times. */
const wallIndex = (w: Wall) => Date.UTC(w.y, w.m - 1, w.d) / MINUTE_MS + w.minute;
const dayIndex = (day: Day) => Date.UTC(day.y, day.m - 1, day.d) / MINUTE_MS;

/** The zone's UTC offset at `t`, in minutes. */
function offset(t: number, zone: string): number {
  const at = Math.floor(t / MINUTE_MS) * MINUTE_MS;
  return wallIndex(wall(at, zone)) - at / MINUTE_MS;
}

export function addDays(day: Day, n: number): Day {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export const sameDay = (a: Day, b: Day) => a.y === b.y && a.m === b.m && a.d === b.d;

/**
 * Every instant whose wall clock in `zone` reads `minute` minutes after the
 * midnight of `day` (1440 is the next midnight): none in a skipped hour, two in
 * a repeated one. Ascending.
 */
export function instants(day: Day, minute: number, zone: string): number[] {
  const target = dayIndex(day) + minute;
  const guess = target * MINUTE_MS;
  // Offsets lie within UTC-12..UTC+14 and change months apart, so every offset
  // that can apply near the target shows up at one of these (whole hours, so
  // they repeat from one candidate to the next).
  const hour = Math.floor(guess / HOUR_MS) * HOUR_MS;
  const offsets = new Set([-18, -9, 0, 9, 18].map((h) => offset(hour + h * HOUR_MS, zone)));
  const found = [...offsets].map((o) => guess - o * MINUTE_MS).filter((t) => wallIndex(wall(t, zone)) === target);
  return [...new Set(found)].sort((a, b) => a - b);
}

/** The one instant a wall-clock time stands for, when there is exactly one. */
export function at(zone: string, y: number, m: number, d: number, hour: number, min = 0): number {
  const found = instants({ y, m, d }, hour * 60 + min, zone);
  if (found.length !== 1) throw new Error(`${y}-${m}-${d} ${hour}:${min} is not one instant in ${zone}`);
  return found[0];
}

/**
 * When `day`'s window ends, as an instant. If the wall clock skips the end, the
 * window ends where the skip starts. If it repeats it, `strict` is the first
 * time the clock reads it and `lenient` the second.
 */
function windowEnd(day: Day, endMin: number, zone: string): { strict: number; lenient: number } {
  const found = instants(day, endMin, zone);
  if (found.length === 1) return { strict: found[0], lenient: found[0] };
  if (found.length === 2) return { strict: found[0], lenient: found[1] };
  // Skipped: the first instant whose wall clock is past the end.
  const target = dayIndex(day) + endMin;
  let lo = (target - 16 * 60) * MINUTE_MS;
  let hi = (target + 16 * 60) * MINUTE_MS;
  while (hi - lo > MINUTE_MS) {
    const mid = Math.floor((lo + hi) / 2 / MINUTE_MS) * MINUTE_MS;
    if (wallIndex(wall(mid, zone)) > target) hi = mid;
    else lo = mid;
  }
  return { strict: hi, lenient: hi };
}

export const stepOf = (durationMin: number) => (durationMin === 15 ? 15 : 30);

/** The criteria's free-time rule, as start times (epoch ms). */
export function reference({ rule, zone, now, until, busy, booked }: SlotsInput): { must: number[]; may: number[] } {
  const step = stepOf(rule.durationMin);
  const length = rule.durationMin * MINUTE_MS;
  const buffer = rule.bufferMin * MINUTE_MS;
  const blocks: Span[] = [...busy, ...booked];
  const free = (from: number, to: number) => blocks.every((b) => !(from < b.end && b.start < to));
  const must = new Set<number>();
  const may = new Set<number>();
  const first: Day = wall(now, zone);
  for (let k = 0; k < rule.aheadDays; k++) {
    const day = addDays(first, k);
    if (!rule.days.includes(new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay())) continue;
    if (rule.maxPerDay !== null) {
      const here = booked.filter((b) => b.here && sameDay(wall(b.start, zone), day)).length;
      if (here >= rule.maxPerDay) continue;
    }
    const end = windowEnd(day, rule.endMin, zone);
    for (let minute = rule.startMin; minute < rule.endMin; minute += step) {
      const found = instants(day, minute, zone);
      for (const start of found) {
        const stop = start + length;
        if (start < now + rule.noticeMin * MINUTE_MS || stop > until) continue;
        if (!free(start - buffer, stop + buffer)) continue;
        // On the wall clock, or as start + length against the window's end instant.
        const byWall = minute + rule.durationMin <= rule.endMin;
        if (byWall || stop <= end.lenient) may.add(start);
        if (found.length === 1 && byWall && stop <= end.strict) must.add(start);
      }
    }
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { must: sorted(must), may: sorted(may) };
}

/** A small seeded random source (mulberry32), so a failing case can be run again. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An instant as the zone's wall clock, for failure messages. */
export function show(t: number, zone: string): string {
  const w = wall(t, zone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${two(w.m)}-${two(w.d)} ${two(Math.floor(w.minute / 60))}:${two(w.minute % 60)} (${new Date(t).toISOString()})`;
}
