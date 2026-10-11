// Availability maths on top of the API data. "Free" means: no event in any of
// the person's calendars at that time.

import {
  atLeast,
  intersect,
  intersectAll,
  merge,
  overlaps,
  subtract,
  type Interval,
} from "./intervals";
import { addDays, dayStart, weekday, zonedTime } from "./time";
import type { BusyBlock, DataStatus, PersonAvailability, WorkingHours } from "./types";

export type Hours = { start: number; end: number };

export function dayWindow(day: string, hours: Hours, tz: string): Interval {
  return [zonedTime(day, hours.start, tz), zonedTime(day, hours.end, tz)];
}

/**
 * The company's working hours that fall on `day` as seen in `tz`. They're
 * defined in their own zone, so for a viewer elsewhere they can start or end
 * at a different wall-clock hour, or spill over from the neighbouring day.
 */
export function workingIntervals(day: string, tz: string, wh: WorkingHours): Interval[] {
  const bounds: Interval = [dayStart(day, tz), dayStart(addDays(day, 1), tz)];
  const out: Interval[] = [];
  // Zones are at most a day apart, so the day before and after cover it.
  for (const d of [addDays(day, -1), day, addDays(day, 1)]) {
    if (!wh.days.includes(weekday(d))) continue;
    out.push([zonedTime(d, wh.start, wh.timezone), zonedTime(d, wh.end, wh.timezone)]);
  }
  return intersect(merge(out), [bounds]);
}

/**
 * Where free time is looked for on a day: the search hours, cut down to
 * working hours unless off-hours are shown (`wh` null).
 */
export function searchWindows(day: string, hours: Hours, tz: string, wh: WorkingHours | null): Interval[] {
  const win = dayWindow(day, hours, tz);
  if (win[1] <= win[0]) return [];
  return wh ? intersect([win], workingIntervals(day, tz, wh)) : [win];
}

export function busyOf(p: PersonAvailability): Interval[] {
  return merge(p.busy.map((b) => [b.start, b.end]));
}

export function freeIn(p: PersonAvailability, windows: Interval[]): Interval[] {
  const busy = busyOf(p);
  return windows.flatMap((w) => subtract(w, busy));
}

export function commonFree(
  people: PersonAvailability[],
  windows: Interval[],
): Interval[] {
  if (people.length === 0) return [];
  return intersectAll(people.map((p) => freeIn(p, windows)));
}

export function isFree(p: PersonAvailability, range: Interval): boolean {
  return !overlaps(busyOf(p), range);
}

export function blocksDuring(
  p: PersonAvailability,
  range: Interval,
): BusyBlock[] {
  return p.busy.filter((b) => b.start < range[1] && b.end > range[0]);
}

/** Earliest moment in [from, until) when the person has nothing on. */
export function nextFree(
  p: PersonAvailability,
  from: number,
  until: number,
): number | null {
  const free = subtract([from, until], busyOf(p));
  return free.length ? free[0][0] : null;
}

export type DayFilter = "all" | "weekdays" | "weekends";

export function daysInRange(start: string, count: number, filter: DayFilter) {
  const days: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = addDays(start, i);
    const wd = weekday(d);
    const weekend = wd === 0 || wd === 6;
    if (filter === "weekdays" && weekend) continue;
    if (filter === "weekends" && !weekend) continue;
    days.push(d);
  }
  return days;
}

export type DaySlots = { day: string; slots: Interval[] };

/** Search windows of a day, trimmed so nothing before `notBefore` counts. */
export type WindowsFor = (day: string) => Interval[];

function upcoming(windows: Interval[], notBefore: number): Interval[] {
  return windows.map(([s, e]): Interval => [Math.max(s, notBefore), e]).filter(([s, e]) => e > s);
}

export function findSlots(
  people: PersonAvailability[],
  days: string[],
  windowsFor: WindowsFor,
  minMs: number,
  notBefore: number,
): DaySlots[] {
  return days
    .map((day) => {
      const windows = upcoming(windowsFor(day), notBefore);
      return { day, slots: windows.length ? atLeast(commonFree(people, windows), minMs) : [] };
    })
    .filter((d) => d.slots.length > 0);
}

export type AlmostSlot = { day: string; slot: Interval; missing: PersonAvailability };

/** Slots where everyone but one person is free — useful when nothing fits all. */
export function almostSlots(
  people: PersonAvailability[],
  days: string[],
  windowsFor: WindowsFor,
  minMs: number,
  notBefore: number,
): AlmostSlot[] {
  if (people.length < 3) return [];
  const out: AlmostSlot[] = [];
  for (const day of days) {
    const windows = upcoming(windowsFor(day), notBefore);
    if (windows.length === 0) continue;
    for (const missing of people) {
      const others = people.filter((p) => p !== missing);
      const slots = atLeast(
        intersect(commonFree(others, windows), busyOf(missing)),
        minMs,
      );
      for (const slot of slots) out.push({ day, slot, missing });
    }
  }
  return out.sort((a, b) => a.slot[0] - b.slot[0]);
}

/** Greedy lane packing so overlapping blocks of one person sit side by side. */
export function assignLanes(blocks: { start: number; end: number }[]) {
  const ends: number[] = [];
  const lanes = blocks.map((b) => {
    let lane = ends.findIndex((end) => end <= b.start);
    if (lane === -1) {
      lane = ends.length;
      ends.push(b.end);
    } else {
      ends[lane] = b.end;
    }
    return lane;
  });
  return { lanes, count: Math.max(1, ends.length) };
}

/**
 * Whether we know when this person is free. Someone without trustworthy
 * calendar data must not look free: they're left out of "everyone free" and
 * shown with the reason instead.
 */
export function hasData(p: PersonAvailability): boolean {
  return p.data === "ok";
}

const NO_DATA: Record<Exclude<DataStatus, "ok">, { short: string; long: string }> = {
  noCalendars: { short: "No calendars", long: "hasn't picked any calendars yet" },
  signInAgain: { short: "Needs to sign in", long: "needs to sign in again" },
  syncing: { short: "Loading…", long: "calendars are still loading" },
  failing: { short: "No recent data", long: "calendars couldn't be read lately" },
};

/** Why we don't know when someone is free, or null when we do. */
export function noDataText(p: PersonAvailability): { short: string; long: string } | null {
  return p.data === "ok" ? null : NO_DATA[p.data];
}

/** "Not counted: Can (needs to sign in again), Deniz (…)." — or null if everyone counts. */
export function leftOutNote(people: PersonAvailability[]): string | null {
  const out = people.filter((p) => !hasData(p));
  if (out.length === 0) return null;
  return `Not counted: ${out.map((p) => `${p.name.split(/\s+/)[0]} (${NO_DATA[p.data as Exclude<DataStatus, "ok">].long})`).join(", ")}.`;
}
