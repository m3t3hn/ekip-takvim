// Calendar-day helpers. A "day key" is YYYY-MM-DD in the team's configured
// timezone; all wall-clock maths goes through it so the browser's own
// timezone never leaks in.

import { TZDate } from "@date-fns/tz";

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const DAY = 24 * HOUR;

function parts(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, m, d];
}

export function isDayKey(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = parts(value);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Epoch ms of `hour` (0–24, fractional allowed) on `key` in `tz`. */
export function zonedTime(key: string, hour: number, tz: string): number {
  const [y, m, d] = parts(key);
  const h = Math.floor(hour);
  const min = Math.round((hour - h) * 60);
  return new TZDate(y, m - 1, d, h, min, 0, tz).getTime();
}

export function dayStart(key: string, tz: string): number {
  return zonedTime(key, 0, tz);
}

const keyFormatters = new Map<string, Intl.DateTimeFormat>();

export function dayKeyOf(epoch: number, tz: string): string {
  let f = keyFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    keyFormatters.set(tz, f);
  }
  return f.format(epoch);
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = parts(key);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(key: string): number {
  const [y, m, d] = parts(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Same day of month n months away, clamped (31 Jan + 1 → 28/29 Feb). */
export function addMonths(key: string, n: number): string {
  const [y, m, d] = parts(key);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

export function startOfWeek(key: string, weekStartsOn: 0 | 1): string {
  const diff = (weekday(key) - weekStartsOn + 7) % 7;
  return addDays(key, -diff);
}

export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round(
    (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY,
  );
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatTime(epoch: number, tz: string): string {
  let f = timeFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    timeFormatters.set(tz, f);
  }
  return f.format(epoch);
}

export function formatRange(start: number, end: number, tz: string): string {
  const e = formatTime(end, tz);
  // An interval that ends exactly at the next midnight reads better as 24:00.
  const endLabel =
    e === "00:00" && dayKeyOf(end, tz) !== dayKeyOf(start, tz) ? "24:00" : e;
  return `${formatTime(start, tz)}–${endLabel}`;
}

/** "Tue, 6 Oct" style label for a day key (calendar date, no tz needed). */
export function formatDay(
  key: string,
  style: "short" | "long" = "short",
): string {
  const [y, m, d] = parts(key);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: style === "long" ? "long" : "short",
    day: "numeric",
    month: style === "long" ? "long" : "short",
  }).format(Date.UTC(y, m - 1, d));
}

export function formatHours(ms: number): string {
  const h = ms / HOUR;
  if (h === 0) return "0h";
  if (h < 1) return `${Math.round(ms / MINUTE)}m`;
  const rounded = Math.round(h * 2) / 2;
  return `${rounded % 1 ? rounded.toFixed(1) : rounded}h`;
}

export function hourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

export function currentDayKey(tz: string): string {
  return dayKeyOf(Date.now(), tz);
}

export function serverTime(): number {
  return Date.now();
}

export function isTimeZone(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The configured label for a zone ("UK"), or its city ("New York"). */
export function zoneLabel(zone: string, zones: { label: string; zone: string }[]): string {
  const known = zones.find((z) => z.zone === zone);
  if (known) return known.label;
  const city = zone.split("/").pop() ?? zone;
  return city.replace(/_/g, " ");
}

/** "UTC+3", "UTC+5:30", "UTC" at the given moment (DST aware). */
export function offsetLabel(zone: string, at: number): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return (part ?? "GMT").replace("GMT", "UTC");
}
