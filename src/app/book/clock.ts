// How the booking pages write times for a visitor: on the visitor's own clock,
// in their time zone and with their 12- or 24-hour preference, which come from
// their browser. Dates and words stay English. Only the visitor pages use
// these; the rest of the app keeps its own formats (src/lib/time.ts).

import { MINUTE, dayKeyOf, formatDay, wallClock } from "@/lib/time";

/** The visitor's clock: their time zone, and whether they read times as "4:00 pm" rather than "16:00". */
export type VisitorClock = { zone: string; hour12: boolean };

/** Zones that are UTC by another name: they read "UTC". */
const UTC_NAMES = new Set([
  "UTC",
  "Etc/UTC",
  "UCT",
  "Etc/UCT",
  "Universal",
  "Etc/Universal",
  "Zulu",
  "Etc/Zulu",
  "GMT",
  "Etc/GMT",
  "GMT0",
  "Etc/GMT0",
  "GMT+0",
  "Etc/GMT+0",
  "GMT-0",
  "Etc/GMT-0",
  "Greenwich",
  "Etc/Greenwich",
]);

/** How far the clock in `zone` is ahead of UTC at `at`, in minutes. */
function offsetMinutes(zone: string, at: number): number {
  const c = wallClock(at, zone);
  const [y, m, d] = c.day.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d, c.hour, c.minute, c.second, c.ms) - at) / MINUTE);
}

/** "GMT+3", "GMT−5" (with a real minus sign), "GMT+5:30", or "GMT" for no offset: the one in effect at `at`. */
export function gmtOffset(zone: string, at: number): string {
  const minutes = offsetMinutes(zone, at);
  if (minutes === 0) return "GMT";
  const abs = Math.abs(minutes);
  const rest = abs % 60;
  return `GMT${minutes < 0 ? "−" : "+"}${Math.floor(abs / 60)}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

/**
 * A time zone as visitors read it, with the offset in effect at `at`:
 * "Istanbul time (GMT+3)", "New York time (GMT−5)". The city is the zone's
 * last part, with spaces for underscores. UTC reads "UTC". A zone that names
 * no place reads as its offset: Etc/GMT-3 is "GMT+3", as those names have the
 * sign reversed.
 */
export function zoneName(zone: string, at: number): string {
  if (UTC_NAMES.has(zone)) return "UTC";
  const offset = gmtOffset(zone, at);
  if (zone.startsWith("Etc/") || !zone.includes("/")) return offset;
  return `${zone.slice(zone.lastIndexOf("/") + 1).replace(/_/g, " ")} time (${offset})`;
}

/**
 * Whether people with `locale` read times on a 12-hour clock, as en-US does
 * ("4:00 pm"), rather than a 24-hour one, as en-GB and tr-TR do ("16:00").
 * Without a locale, the browser's own.
 */
export function prefersHour12(locale?: string): boolean {
  let cycle: string | undefined;
  try {
    cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  } catch {
    // Not a locale Intl can read: the browser's own.
    cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
  }
  return cycle === "h12" || cycle === "h11";
}

/** "16:00", or "4:00 pm" on a 12-hour clock. */
export function timeLabel(epoch: number, { zone, hour12 }: VisitorClock): string {
  const { hour, minute } = wallClock(epoch, zone);
  const mm = String(minute).padStart(2, "0");
  if (!hour12) return `${String(hour).padStart(2, "0")}:${mm}`;
  return `${hour % 12 || 12}:${mm} ${hour < 12 ? "am" : "pm"}`;
}

/** "16:00–16:30", or "4:00 pm–4:30 pm". On a 24-hour clock, an end at the next midnight reads 24:00. */
export function rangeLabel(start: number, end: number, clock: VisitorClock): string {
  let to = timeLabel(end, clock);
  if (!clock.hour12 && to === "00:00" && dayKeyOf(end, clock.zone) !== dayKeyOf(start, clock.zone)) to = "24:00";
  return `${timeLabel(start, clock)}–${to}`;
}

/** The visitor's day of `epoch`: "Monday 30 November". */
export function dayLabel(epoch: number, clock: VisitorClock): string {
  return formatDay(dayKeyOf(epoch, clock.zone), "long");
}

/** A booked or picked time: "Monday 30 November, 16:00–16:30". */
export function whenLabel({ start, end }: { start: number; end: number }, clock: VisitorClock): string {
  return `${dayLabel(start, clock)}, ${rangeLabel(start, end, clock)}`;
}

/** A time button's name for screen readers, its day with its time: "Monday 30 November, 16:00". */
export function slotName(start: number, clock: VisitorClock): string {
  return `${dayLabel(start, clock)}, ${timeLabel(start, clock)}`;
}
