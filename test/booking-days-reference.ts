// Full days (run 2026-11-25-ekip-quick-wins-visitor, criterion 3), stated
// again from the criteria on top of booking-reference.ts's free-time rule. It
// shares no code with src/, so the two can be compared.
//
// - A day the link offers is one of its weekdays, within its days ahead, with
//   at least one time its hours and minimum notice allow (and that ends within
//   the synced days, as every offered time does).
// - It's full when none of those times is free: its bookings per day are
//   reached, or the host is busy (or booked) at each of them.
// - Its entry is the first time it would have offered.
// - On the visitor's clock: free times by the visitor's day; a full day on the
//   visitor's day of its first time, unless that day has free times; in date
//   order; and nothing at all when no time is free.
//
// On a day the clocks change, booking-reference.ts gives two answers (`must`
// and `may`); so does this, per day.

import { reference, wall, type SlotsInput, type Span } from "./booking-reference";

/** A calendar date in a zone, as YYYY-MM-DD. */
export function dayIn(t: number, zone: string): string {
  const w = wall(t, zone);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** Two readings of one host day: under every reading of the criteria (must) and under some (may). */
type Both = { must: number[]; may: number[] };

export type HostDay = {
  day: string;
  /** Its times the hours, the clock, the notice and the synced days allow, free or not. */
  allowed: Both;
  /** Of those, the ones free: not busy, not booked, and the day not at its bookings per day. */
  free: Both;
};

/** Every host day with a time the link's hours and notice allow, by its date on the host's clock. */
export function hostDays(input: SlotsInput): Map<string, HostDay> {
  // The same rule with nothing busy, nothing booked and no cap: the times the day would offer.
  const allowed = reference({ ...input, rule: { ...input.rule, maxPerDay: null }, busy: [], booked: [] });
  const free = reference(input);
  const days = new Map<string, HostDay>();
  const of = (t: number) => {
    const day = dayIn(t, input.zone);
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, allowed: { must: [], may: [] }, free: { must: [], may: [] } }));
    return d;
  };
  for (const t of allowed.must) of(t).allowed.must.push(t);
  for (const t of allowed.may) of(t).allowed.may.push(t);
  for (const t of free.must) of(t).free.must.push(t);
  for (const t of free.may) of(t).free.may.push(t);
  return days;
}

/** What the criteria say about one host day being full. */
export type FullVerdict = {
  day: string;
  /** Full under every reading: offered, and no time free under any. */
  certain: boolean;
  /** Full under some reading. */
  possible: boolean;
  /** Its times that may be its entry: allowed under some reading, and no later than its first under every reading. */
  firsts: number[];
  /** Whether the day reads the same under every reading. */
  plain: boolean;
};

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function fullVerdicts(input: SlotsInput): FullVerdict[] {
  const out: FullVerdict[] = [];
  for (const d of hostDays(input).values()) {
    const certain = d.allowed.must.length > 0 && d.free.may.length === 0;
    const possible = d.allowed.may.length > 0 && d.free.must.length === 0;
    const latest = d.allowed.must.length ? d.allowed.must[0] : Infinity;
    out.push({
      day: d.day,
      certain,
      possible,
      firsts: d.allowed.may.filter((t) => t <= latest),
      plain: same(d.allowed.must, d.allowed.may) && same(d.free.must, d.free.may),
    });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * The full days on a day without a clock change, as the criteria give them
 * exactly: each one's first time, ascending. Throws on a day with two readings.
 */
export function plainFullDays(input: SlotsInput): number[] {
  const out: number[] = [];
  for (const v of fullVerdicts(input)) {
    if (!v.plain) throw new Error(`${v.day} reads two ways`);
    if (v.certain) out.push(v.firsts[0]);
  }
  return out;
}

/** One day of the visitor's list. */
export type VisitorDay = { day: string; slots: number[]; full: boolean };

/** The visitor's list from the free times and the full days' entries, on the visitor's clock. */
export function visitorDays(slots: Span[], full: number[], zone: string): VisitorDay[] {
  if (slots.length === 0) return [];
  const days = new Map<string, VisitorDay>();
  for (const s of slots) {
    const day = dayIn(s.start, zone);
    const d = days.get(day);
    if (d) d.slots.push(s.start);
    else days.set(day, { day, slots: [s.start], full: false });
  }
  for (const t of full) {
    const day = dayIn(t, zone);
    if (!days.has(day)) days.set(day, { day, slots: [], full: true });
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}
