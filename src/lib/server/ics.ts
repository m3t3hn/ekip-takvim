import { createHash } from "node:crypto";
import { expandRecurringEvent, sync as ical, type EventInstance, type RRule, type VEvent } from "node-ical";
import { DAY } from "@/lib/time";
import { EVENT_TEXT_LIMITS, htmlToText, type Busy, type EventDetails } from "./google";

// Busy time from an iCalendar file (RFC 5545), the format a calendar link serves.
//
// node-ical parses recurrence rules and expands them, but on its own it reads a
// time without a zone, or with a TZID it doesn't know, in the server's own zone;
// it ignores the VTIMEZONE blocks a file defines for names that aren't IANA or
// Windows zones; and one malformed recurring event makes it throw for the whole
// file. So every time is read here first, in the zone it names (the person's zone
// when it names none or one that can't be resolved), and node-ical only sees one
// recurring event at a time, with its wall-clock times written as UTC. It expands
// the rule in wall-clock time, as RFC 5545 defines it, and each occurrence is put
// back in its zone afterwards. Nothing depends on the zone the server runs in.

export class IcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IcsError";
  }
}

export type IcsOptions = {
  /** Blocks overlapping [from, to) come back. */
  from: Date | number;
  to: Date | number;
  /** The person's zone: times without a zone and all-day events are read in it. */
  timezone: string;
  /** Most blocks returned, earliest first (default 5000). */
  limit?: number;
};

export type IcsResult = {
  /** One block per occurrence, sorted by start, no two with the same eventId. */
  busy: Busy[];
  /** Events left out because they couldn't be read. */
  skipped: number;
  /** More than `limit` occurrences overlapped the window: the earliest `limit` came back. */
  truncated: boolean;
};

const DEFAULT_LIMIT = 5000;
// Recurrence periods node-ical may walk in one call (its own default is 10,000).
// A rule with COUNT is walked from its first occurrence, so a daily one that
// started decades ago needs more; a window with more periods is split instead.
const MAX_ITERATIONS = 50_000;
const MIN_CHUNK_MS = 60_000;
const UID_MAX = 200;

/** Busy blocks from an iCalendar file. Throws IcsError when the text isn't one. */
export function icsBusy(text: string, options: IcsOptions): IcsResult {
  const from = new Date(options.from).getTime();
  const to = new Date(options.to).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new RangeError("icsBusy needs a valid from and to");
  const zoneName = canonicalZone(options.timezone);
  if (!zoneName) throw new RangeError(`Unknown time zone: ${options.timezone}`);
  const requested = options.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : DEFAULT_LIMIT;

  return quietly(() => {
    const { events, zones: definitions, unfinished } = readCalendar(text);
    const reader = new Reader(ianaZone(zoneName), definitions, new Collector(from, to, limit));
    reader.skipped += unfinished;
    for (const component of events) reader.add(component);
    reader.finish();
    const { busy, truncated } = reader.out.result();
    return { busy, skipped: reader.skipped, truncated };
  });
}

// node-ical reports what it drops with console.warn, once per event: a file with
// thousands of broken rules would write thousands of lines to the server's log at
// every sync. What it drops is counted in `skipped` instead. icsBusy is
// synchronous, so nothing else runs while the console is quiet.
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

function quietly<T>(work: () => T): T {
  const saved = CONSOLE_METHODS.map((name) => console[name]);
  const quiet = () => undefined;
  for (const name of CONSOLE_METHODS) console[name] = quiet;
  try {
    return work();
  } finally {
    CONSOLE_METHODS.forEach((name, i) => (console[name] = saved[i]));
  }
}

// ---------------------------------------------------------------------------
// Reading the file: unfolded content lines, then components.

type Prop = { name: string; params: Map<string, string>; value: string };
type Component = { type: string; props: Prop[]; children: Component[]; closed: boolean };

function* contentLines(text: string): Generator<string> {
  let current: string | undefined;
  // Past a byte-order mark and blank space before the first line.
  let start = /^\uFEFF?\s*/.exec(text)![0].length;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    start = end + 1;
    // A line starting with a space or tab continues the one before (RFC 5545 §3.1).
    if (current !== undefined && (line.startsWith(" ") || line.startsWith("\t"))) {
      current += line.slice(1);
      continue;
    }
    if (current !== undefined) yield current;
    current = line;
  }
  if (current !== undefined) yield current;
}

/** NAME;PARAM=value;PARAM="quoted:value":VALUE, or null for a line that isn't one. */
function parseProp(line: string): Prop | null {
  const name = /^[A-Za-z0-9-]+/.exec(line)?.[0];
  if (!name) return null;
  const params = new Map<string, string>();
  let i = name.length;
  while (line[i] === ";") {
    const eq = line.indexOf("=", i + 1);
    if (eq === -1) return null;
    const key = line.slice(i + 1, eq).trim().toUpperCase();
    let value = "";
    let j = eq + 1;
    for (;;) {
      if (line[j] === '"') {
        const close = line.indexOf('"', j + 1);
        if (close === -1) return null;
        value += line.slice(j + 1, close);
        j = close + 1;
      } else {
        let k = j;
        while (k < line.length && line[k] !== ";" && line[k] !== ":" && line[k] !== ",") k++;
        value += line.slice(j, k);
        j = k;
      }
      if (line[j] !== ",") break;
      value += ",";
      j++;
    }
    if (!params.has(key)) params.set(key, value);
    i = j;
  }
  if (line[i] !== ":") return null;
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

// What RFC 5545 puts in a calendar and never in an event, which holds only alarms.
const CALENDAR_LEVEL = new Set(["VCALENDAR", "VEVENT", "VTODO", "VJOURNAL", "VFREEBUSY", "VTIMEZONE"]);

function readCalendar(text: string): { events: Component[]; zones: Map<string, Component>; unfinished: number } {
  if (typeof text !== "string") throw new IcsError("This isn't an iCalendar file");
  const root: Component = { type: "", props: [], children: [], closed: true };
  const stack = [root];
  // Open components by type (the root aside): an END that closes nothing is
  // passed over, and any other walks the stack only past what it closes, so
  // reading stays linear. Searching the whole stack for each END made stray ENDs
  // under deep nesting quadratic.
  const open = new Map<string, number>();
  /** The innermost open component of a type closes, with whatever is still open inside it. */
  const close = (type: string, finished: boolean) => {
    let i = stack.length - 1;
    while (stack[i].type !== type) i--;
    stack[i].closed = finished;
    for (const left of stack.splice(i)) open.set(left.type, open.get(left.type)! - 1);
  };
  let calendar = false;
  for (const line of contentLines(text)) {
    const prop = parseProp(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const type = prop.value.trim().toUpperCase();
      if (type === "VCALENDAR") calendar = true;
      // An event still open here was never finished: it stays unread, and what
      // follows isn't taken to be inside it.
      if (CALENDAR_LEVEL.has(type) && open.get("VEVENT")) close("VEVENT", false);
      const component: Component = { type, props: [], children: [], closed: false };
      stack[stack.length - 1].children.push(component);
      stack.push(component);
      open.set(type, (open.get(type) ?? 0) + 1);
    } else if (prop.name === "END") {
      const type = prop.value.trim().toUpperCase();
      if (open.get(type)) close(type, true);
    } else {
      stack[stack.length - 1].props.push(prop);
    }
  }
  if (!calendar) throw new IcsError("This isn't an iCalendar file: it has no BEGIN:VCALENDAR");

  const events: Component[] = [];
  const zones = new Map<string, Component>();
  let unfinished = 0;
  // In file order, with a stack of its own: a file can nest components deeper
  // than the call stack goes.
  const pending = [...root.children].reverse();
  while (pending.length) {
    const component = pending.pop()!;
    if (component.type === "VEVENT") {
      // An event cut off before its END:VEVENT can't be read.
      if (component.closed) events.push(component);
      else unfinished++;
    } else if (component.type === "VTIMEZONE") {
      const tzid = first(component, "TZID")?.value.trim();
      if (tzid && !zones.has(tzid)) zones.set(tzid, component);
    } else {
      for (let i = component.children.length - 1; i >= 0; i--) pending.push(component.children[i]);
    }
  }
  return { events, zones, unfinished };
}

function first(component: Component, name: string): Prop | undefined {
  return component.props.find((p) => p.name === name);
}

function every(component: Component, name: string): Prop[] {
  return component.props.filter((p) => p.name === name);
}

/** TEXT values escape backslash, semicolon, comma and newline (RFC 5545 §3.3.11). */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

// ---------------------------------------------------------------------------
// Dates. A "wall" time is a date and clock time written as if it were UTC
// (Date.UTC of its fields); a zone turns it into an instant.

type Stamp = { date: true; wall: number } | { date: false; wall: number; utc: boolean };

function utcMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const d = new Date(0);
  // setUTCFullYear, unlike Date.UTC, doesn't turn years 0-99 into 1900-1999.
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(hour, minute, second, 0);
  return d.getTime();
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i;

function parseStamp(raw: string, valueType?: string): Stamp | null {
  const m = DATE_TIME.exec(raw.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(utcMs(year, month, 0)).getUTCDate()) return null;
  if (m[4] === undefined || valueType?.toUpperCase() === "DATE") return { date: true, wall: utcMs(year, month - 1, day) };
  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (hour > 23 || minute > 59 || second > 60) return null;
  return { date: false, wall: utcMs(year, month - 1, day, hour, minute, Math.min(second, 59)), utc: m[7] !== "" };
}

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

/** Days are nominal (same clock time on a later day), hours and less are exact. */
function parseDuration(raw: string): { days: number; ms: number } | null {
  const value = raw.trim();
  const m = DURATION.exec(value);
  if (!m || !m.slice(2).some(Boolean) || /T$/i.test(value)) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const n = (i: number) => Number(m[i] ?? 0);
  return { days: sign * (n(2) * 7 + n(3)), ms: sign * ((n(4) * 60 + n(5)) * 60 + n(6)) * 1000 };
}

function wallText(wall: number): string {
  const iso = new Date(wall).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

const dayText = (wall: number) => wallText(wall).slice(0, 8);
const floorDay = (wall: number) => Math.floor(wall / DAY) * DAY;
// Walls node-ical can be handed: four-digit years.
const MIN_WALL = utcMs(1, 0, 1);
const MAX_WALL = utcMs(9999, 11, 31);

// ---------------------------------------------------------------------------
// Zones. Each gives its UTC offset (ms) at an instant; the conversions below
// are the same for an IANA zone, a fixed offset and a VTIMEZONE block.

type Zone = { offset(instant: number): number };

const UTC: Zone = { offset: () => 0 };

/** The wall time an instant shows in a zone. */
function toWall(instant: number, zone: Zone): number {
  return instant + zone.offset(instant);
}

/**
 * The instant a wall time stands for in a zone. A time skipped by a DST change
 * moves forward by the gap; a time that happens twice is the first one (RFC 5545
 * §3.3.5, and what JavaScript's Temporal calls "compatible").
 */
function toInstant(wall: number, zone: Zone): number {
  const before = zone.offset(wall - DAY);
  const after = zone.offset(wall + DAY);
  const early = wall - before;
  const late = wall - after;
  const earlyFits = zone.offset(early) === before;
  const lateFits = zone.offset(late) === after;
  if (earlyFits && lateFits) return Math.min(early, late);
  if (lateFits) return late;
  return early;
}

const zoneNames = new Map<string, string | null>();

/** The canonical IANA name ("europe/berlin" → "Europe/Berlin"), or null. */
function canonicalZone(name: string): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  let canonical = zoneNames.get(name);
  if (canonical === undefined) {
    try {
      canonical = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
    } catch {
      canonical = null;
    }
    if (zoneNames.size > 2000) zoneNames.clear();
    zoneNames.set(name, canonical);
  }
  return canonical;
}

const ianaZones = new Map<string, Zone>();

function ianaZone(name: string): Zone {
  let zone = ianaZones.get(name);
  if (zone) return zone;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: name,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const exact = (instant: number) => {
    const t = Math.floor(instant / 1000) * 1000;
    const p: Record<string, number> = {};
    for (const part of format.formatToParts(t)) p[part.type] = Number(part.value);
    return utcMs(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  // Offsets by UTC day, for days without a change: a calendar asks for the same
  // days over and over.
  const days = new Map<number, number>();
  zone = {
    offset(instant) {
      const day = Math.floor(instant / DAY);
      const known = days.get(day);
      if (known !== undefined) return known;
      const offset = exact(instant);
      if (exact(day * DAY) === offset && exact(day * DAY + DAY - 1000) === offset) {
        if (days.size > 5000) days.clear();
        days.set(day, offset);
      }
      return offset;
    },
  };
  ianaZones.set(name, zone);
  return zone;
}

function fixedZone(offset: number): Zone {
  return { offset: () => offset };
}

// node-ical ships Microsoft's table of Windows zone names ("W. Europe Standard
// Time", "(UTC+01:00) Amsterdam, Berlin, …"), but doesn't export it: a parsed
// date carries the IANA zone it was mapped to. Names Outlook makes up for a zone
// of its own make node-ical fall back to the server's zone, so they're never asked.
const OUTLOOK_CUSTOM = /^(?:tzone:\/\/Microsoft\/|Customized Time Zone|\(no TZ description\))/i;
const mappedNames = new Map<string, string | null>();

function windowsZone(tzid: string): string | null {
  if (OUTLOOK_CUSTOM.test(tzid) || /["\r\n]/.test(tzid)) return null;
  let mapped = mappedNames.get(tzid);
  if (mapped === undefined) {
    try {
      const probe = ical.parseICS(
        `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:z\r\nDTSTART;TZID="${tzid}":20260101T120000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
      );
      const tz = (probe.z as VEvent | undefined)?.start?.tz;
      mapped = tz ? canonicalZone(tz) : null;
    } catch {
      mapped = null;
    }
    if (mappedNames.size > 1000) mappedNames.clear();
    mappedNames.set(tzid, mapped);
  }
  return mapped;
}

const OFFSET_LABEL = /^\(?\s*(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?(?!\d)/i;

/** "UTC+02:00", "GMT-0400", "+0530", "(UTC+05:30) …" as a fixed offset. */
function labelOffset(tzid: string): number | null {
  const m = OFFSET_LABEL.exec(tzid.trim());
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = Number(m[3] ?? 0);
  if (hours > 14 || minutes > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes) * 60_000;
}

const UTC_OFFSET = /^([+-])(\d{2}):?(\d{2})(?::?(\d{2}))?$/;

function parseUtcOffset(raw: string | undefined): number | null {
  const m = raw === undefined ? null : UTC_OFFSET.exec(raw.trim());
  if (!m) return null;
  const ms = ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

type Observance = { from: number; to: number; start: number; rule: RRule | null; dates: number[] };

/**
 * A zone from a VTIMEZONE block: each STANDARD or DAYLIGHT part says from when
 * (DTSTART, and an RRULE or RDATEs for the later changes) which offset applies.
 * The rules are expanded by node-ical, in the part's own wall time.
 */
function vtimezoneZone(component: Component): Zone | null {
  const observances: Observance[] = [];
  for (const part of component.children) {
    if (part.type !== "STANDARD" && part.type !== "DAYLIGHT") continue;
    const from = parseUtcOffset(first(part, "TZOFFSETFROM")?.value);
    const to = parseUtcOffset(first(part, "TZOFFSETTO")?.value);
    const start = parseStamp(first(part, "DTSTART")?.value ?? "");
    if (from === null || to === null || !start) return null;
    // Changes are written in the wall time before them, UNTIL in UTC.
    const wallOf = (stamp: Stamp) => (stamp.date ? stamp.wall + DAY - 1000 : stamp.utc ? stamp.wall + from : stamp.wall);
    let rule: RRule | null = null;
    const rrule = first(part, "RRULE")?.value;
    if (rrule) {
      rule = recurrence(start.wall, rrule, wallOf);
      if (!rule) return null;
    }
    const dates: number[] = [];
    for (const prop of every(part, "RDATE")) {
      for (const value of prop.value.split(",")) {
        const stamp = parseStamp(value, prop.params.get("VALUE"));
        if (stamp) dates.push(!stamp.date && stamp.utc ? stamp.wall + from : stamp.wall);
      }
    }
    observances.push({ from, to, start: start.wall, rule, dates });
  }
  if (!observances.length) return null;
  const earliest = observances.reduce((a, b) => (b.start - b.from < a.start - a.from ? b : a));

  const years = new Map<number, { at: number; offset: number }[]>();
  const changesAround = (year: number) => {
    let changes = years.get(year);
    if (changes) return changes;
    const lo = utcMs(year - 1, 0, 1) - DAY;
    const hi = utcMs(year + 2, 0, 1) + DAY;
    changes = [];
    for (const o of observances) {
      const walls = [o.start, ...o.dates];
      if (o.rule) {
        for (const d of o.rule.between(new Date(lo), new Date(hi), true)) walls.push(d.getTime());
        const before = o.rule.before(new Date(lo));
        if (before) walls.push(before.getTime());
      }
      for (const wall of walls) changes.push({ at: wall - o.from, offset: o.to });
    }
    changes.sort((a, b) => a.at - b.at);
    if (years.size > 50) years.clear();
    years.set(year, changes);
    return changes;
  };
  const zone: Zone = {
    offset(instant) {
      let offset = earliest.from;
      for (const change of changesAround(new Date(instant).getUTCFullYear())) {
        if (change.at > instant) break;
        offset = change.offset;
      }
      return offset;
    },
  };
  try {
    zone.offset(Date.now());
  } catch {
    return null;
  }
  return zone;
}

/** A recurrence rule from node-ical, for a first occurrence at a wall time. */
function recurrence(startWall: number, rrule: string, untilWall: (stamp: Stamp) => number): RRule | null {
  const rule = rewriteRule(rrule, untilWall);
  if (!rule || startWall < MIN_WALL || startWall > MAX_WALL) return null;
  try {
    const parsed = ical.parseICS(
      `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:r\r\nDTSTART:${wallText(startWall)}Z\r\nRRULE:${rule}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
    );
    return (parsed.r as VEvent | undefined)?.rrule ?? null;
  } catch {
    return null;
  }
}

/** The rule with UNTIL as a wall time written as UTC, or null when UNTIL can't be read. */
function rewriteRule(rrule: string, untilWall: (stamp: Stamp) => number): string | null {
  const parts: string[] = [];
  for (const part of rrule.trim().split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim().toUpperCase() === "UNTIL") {
      const stamp = parseStamp(part.slice(eq + 1));
      if (!stamp) return null;
      const wall = Math.min(Math.max(untilWall(stamp), MIN_WALL), MAX_WALL);
      parts.push(`UNTIL=${wallText(wall)}Z`);
    } else {
      parts.push(part.trim().toUpperCase());
    }
  }
  return parts.length ? parts.join(";") : null;
}

// ---------------------------------------------------------------------------
// Events.

/** A start, end, RECURRENCE-ID or EXDATE value. Floating: no zone, or one that can't be resolved. */
type Moment = { allDay: true; wall: number } | { allDay: false; wall: number; zone: Zone; at: number; floating: boolean };

type Item = {
  component: Component;
  index: number;
  uid: string | null;
  start: Moment;
  /** Where it ends: days later (nominal, or whole days when all-day), then ms later (exact). */
  end: { days: number; ms: number };
  rule: string | null;
  exdates: Moment[];
  recurrenceId: Moment | null;
  sequence: number;
};

type Fields = { show: boolean; tentative: boolean; private: boolean; title?: string; details?: EventDetails };

class Reader {
  skipped = 0;
  private index = 0;
  private readonly zoneCache = new Map<string, Zone | null>();
  /** The file's VTIMEZONE blocks by lowercased TZID, the first of each; made when first asked. */
  private folded: Map<string, Component> | undefined;
  /** Zones read from VTIMEZONE blocks, by block. */
  private readonly blockZones = new Map<Component, Zone | null>();
  private readonly groups = new Map<string, Item[]>();
  private readonly loose: Item[] = [];

  constructor(
    private readonly personal: Zone,
    private readonly definitions: Map<string, Component>,
    readonly out: Collector,
  ) {}

  add(component: Component): void {
    this.attempt(() => {
      const item = this.item(component, this.index++);
      if (!item) this.skipped++;
      else if (!item.uid) this.loose.push(item);
      else if (this.groups.has(item.uid)) this.groups.get(item.uid)!.push(item);
      else this.groups.set(item.uid, [item]);
    });
  }

  /** Events without recurrence first: they're cheap, and fill the window early. */
  finish(): void {
    const series: { base: Item; overrides: Item[]; key: string }[] = [];
    const place = (key: string, items: Item[]) => {
      const bases = items.filter((i) => !i.recurrenceId);
      const overrides = items.filter((i) => i.recurrenceId);
      // Revisions of one event: the highest SEQUENCE wins, a later one on a tie.
      const base = bases.reduce<Item | undefined>((a, b) => (!a || b.sequence >= a.sequence ? b : a), undefined);
      if (!base) this.orphans(overrides, key);
      else if (!base.rule) this.single(base, undefined, key);
      else series.push({ base, overrides, key });
    };
    for (const [uid, items] of this.groups) {
      this.attempt(() => place(uid.length <= UID_MAX ? uid : `#${hash(uid).slice(0, 32)}`, items));
    }
    // Without a UID, an event is known by its content.
    const seen = new Map<string, number>();
    for (const item of this.loose) {
      const digest = hash(item.component.props.map((p) => `${p.name};${[...p.params].join(";")}:${p.value}`).join("\n")).slice(0, 24);
      const n = (seen.get(digest) ?? 0) + 1;
      seen.set(digest, n);
      this.attempt(() => place(n === 1 ? `~${digest}` : `~${digest}~${n}`, [item]));
    }
    for (const s of series) this.attempt(() => this.expand(s.base, s.overrides, s.key));
  }

  /** Something unforeseen in one event costs that event, not the file. */
  private attempt(work: () => void): void {
    try {
      work();
    } catch {
      this.skipped++;
    }
  }

  private zone(tzid: string): Zone | null {
    let zone = this.zoneCache.get(tzid);
    if (zone === undefined) {
      zone = this.resolve(tzid);
      this.zoneCache.set(tzid, zone);
    }
    return zone;
  }

  /** An IANA name, a Windows name, a VTIMEZONE in the file, then a "UTC+02:00" style label. */
  private resolve(tzid: string): Zone | null {
    const iana = canonicalZone(tzid) ?? windowsZone(tzid);
    if (iana) return ianaZone(iana);
    const defined = this.definition(tzid);
    const fromBlock = defined ? this.blockZone(defined) : null;
    if (fromBlock) return fromBlock;
    const label = labelOffset(tzid);
    return label === null ? null : fixedZone(label);
  }

  /**
   * The VTIMEZONE block with this TZID, else the first whose TZID differs only in
   * case. The case-blind index is built once: searched per TZID, a file with many
   * blocks and many unknown TZIDs took quadratic time.
   */
  private definition(tzid: string): Component | undefined {
    const exact = this.definitions.get(tzid);
    if (exact) return exact;
    if (!this.folded) {
      this.folded = new Map();
      for (const [id, component] of this.definitions) {
        const key = id.toLowerCase();
        if (!this.folded.has(key)) this.folded.set(key, component);
      }
    }
    return this.folded.get(tzid.toLowerCase());
  }

  /** A block is read once, however many spellings of its TZID ask for it. */
  private blockZone(component: Component): Zone | null {
    let zone = this.blockZones.get(component);
    if (zone === undefined) {
      zone = vtimezoneZone(component);
      this.blockZones.set(component, zone);
    }
    return zone;
  }

  private moment(prop: Prop, value = prop.value): Moment | null {
    const stamp = parseStamp(value, prop.params.get("VALUE"));
    if (!stamp) return null;
    if (stamp.date) return { allDay: true, wall: stamp.wall };
    if (stamp.utc) return { allDay: false, wall: stamp.wall, zone: UTC, at: stamp.wall, floating: false };
    const tzid = prop.params.get("TZID")?.trim();
    // A TZID that can't be resolved is read like a time without a zone.
    const named = tzid ? this.zone(tzid) : null;
    const zone = named ?? this.personal;
    return { allDay: false, wall: stamp.wall, zone, at: toInstant(stamp.wall, zone), floating: !named };
  }

  private item(component: Component, index: number): Item | null {
    const starts = every(component, "DTSTART");
    if (starts.length !== 1) return null;
    const start = this.moment(starts[0]);
    if (!start) return null;
    const dtend = first(component, "DTEND");
    const duration = first(component, "DURATION");
    let end: Item["end"];
    if (dtend) {
      const e = this.moment(dtend);
      if (!e) return null;
      if (e.allDay && start.allDay) {
        // Some producers end a one-day event on its own date: it lasts that day.
        const days = Math.round((e.wall - start.wall) / DAY);
        end = { days: days === 0 ? 1 : days, ms: 0 };
      } else if (!e.allDay && !start.allDay) {
        end = { days: 0, ms: e.at - start.at };
      } else {
        // A date for one end and a date with a time for the other can't be read.
        return null;
      }
    } else if (duration) {
      const d = parseDuration(duration.value);
      if (!d) return null;
      end = start.allDay ? { days: d.days + Math.round(d.ms / DAY), ms: 0 } : d;
    } else {
      // No end: an all-day event is one day, a timed one takes no time.
      end = { days: start.allDay ? 1 : 0, ms: 0 };
    }
    const ridProp = first(component, "RECURRENCE-ID");
    const recurrenceId = ridProp ? this.moment(ridProp) : null;
    if (ridProp && !recurrenceId) return null;
    const exdates: Moment[] = [];
    for (const prop of every(component, "EXDATE")) {
      for (const value of prop.value.split(",")) {
        const m = this.moment(prop, value);
        if (m) exdates.push(m);
      }
    }
    return {
      component,
      index,
      uid: first(component, "UID")?.value.trim() || null,
      start,
      end,
      rule: first(component, "RRULE")?.value.trim() || null,
      exdates,
      recurrenceId,
      sequence: Number.parseInt(first(component, "SEQUENCE")?.value ?? "", 10) || 0,
    };
  }

  /** Midnight starting a day, in the person's zone. */
  private dayStart(wall: number): number {
    return toInstant(wall, this.personal);
  }

  private instantOf(m: Moment): number {
    return m.allDay ? this.dayStart(m.wall) : m.at;
  }

  /** Start and end of an event that doesn't repeat, or of an override, from its own values. */
  private span(item: Item): { start: number; end: number } {
    if (item.start.allDay) {
      return { start: this.dayStart(item.start.wall), end: this.dayStart(item.start.wall + item.end.days * DAY) };
    }
    return { start: item.start.at, end: endAt(item, item.start.wall, item.start.at, item.start.zone) };
  }

  private single(item: Item, base: Item | undefined, eventId: string): void {
    const { start, end } = this.span(item);
    this.out.add(block(start, end, item.start.allDay, fieldsOf(item, base), eventId));
  }

  /** Overrides whose series isn't there or can't be read: each is an event of its own. */
  private orphans(overrides: Item[], key: string): void {
    const latest = new Map<number, Item>();
    for (const o of overrides) {
      const at = this.instantOf(o.recurrenceId!);
      const known = latest.get(at);
      if (!known || o.sequence >= known.sequence) latest.set(at, o);
    }
    for (const o of latest.values()) {
      const rid = o.recurrenceId!;
      this.single(o, undefined, `${key}_${rid.allDay ? dayText(rid.wall) : wallText(rid.wall)}`);
    }
  }

  /**
   * A recurring event. Its values are moved into the wall time of its start
   * (whole days for an all-day event, in the person's zone), node-ical expands
   * the rule there, window by window, and each occurrence is placed in the zone.
   */
  private expand(base: Item, overrides: Item[], key: string): void {
    const allDay = base.start.allDay;
    const zone = base.start.allDay ? this.personal : base.start.zone;
    // An EXDATE or RECURRENCE-ID names an occurrence: written in the series' own
    // terms (same zone, or no zone at all) it is taken as written, otherwise it
    // is converted. A UTC time on an all-day series is a midnight somewhere: the
    // person's zone is the best guess for where.
    const wallOf = (m: Moment): number => {
      if (allDay) return m.allDay ? m.wall : floorDay(m.zone === UTC ? toWall(m.at, this.personal) : m.wall);
      if (!m.allDay && (m.zone === zone || m.floating)) return m.wall;
      return toWall(this.instantOf(m), zone);
    };
    const wallAt = (instant: number) => (allDay ? floorDay(toWall(instant, this.personal)) : toWall(instant, zone));
    const untilWall = (stamp: Stamp) => {
      if (allDay) return stamp.date ? stamp.wall : floorDay(stamp.utc ? toWall(stamp.wall, this.personal) : stamp.wall);
      if (stamp.date) return stamp.wall + DAY - 1000;
      return stamp.utc ? toWall(stamp.wall, zone) : stamp.wall;
    };
    /** Where an occurrence at a wall time starts: an all-day one at midnight in the person's zone. */
    const instantAt = (wall: number) => (allDay ? this.dayStart(wall) : toInstant(wall, zone));
    const fail = () => {
      this.skipped++;
      this.orphans(overrides, key);
    };

    const rule = rewriteRule(base.rule!, untilWall);
    if (!rule || base.start.wall < MIN_WALL || base.start.wall > MAX_WALL) return fail();
    const lines = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:s", `X-INDEX:${base.index}`, `SEQUENCE:${base.sequence}`];
    lines.push(`DTSTART:${wallText(base.start.wall)}Z`, `RRULE:${rule}`);
    const exWalls: string[] = [];
    const exDays: string[] = [];
    // node-ical matches an EXDATE or RECURRENCE-ID by wall time, but on the day
    // the clocks spring forward two wall times stand for one instant: 02:30 isn't
    // on the clock and is read as 03:30 (toInstant), and an exception written in
    // UTC or another zone comes back as 03:30. So an occurrence whose instant an
    // exception names is left out as well (in emit, below). For an all-day series
    // the instant is the day's start, which also covers a rule that gives several
    // times in one day.
    const named = new Set<number>();
    for (const m of base.exdates) {
      // A date on a timed series removes every occurrence that day.
      if (m.allDay && !allDay) {
        exDays.push(dayText(m.wall));
        continue;
      }
      const wall = wallOf(m);
      exWalls.push(`${wallText(wall)}Z`);
      named.add(instantAt(wall));
    }
    if (exWalls.length) lines.push(`EXDATE:${exWalls.join(",")}`);
    if (exDays.length) lines.push(`EXDATE;VALUE=DATE:${exDays.join(",")}`);
    lines.push("END:VEVENT");
    let longest = allDay ? base.end.days * DAY : endAt(base, base.start.wall, base.start.at, zone) - base.start.at;
    // One override per occurrence. Two can name one instant in different words
    // (02:30 and 03:30 on that day, or a time in UTC), which node-ical would take
    // for two occurrences: the highest SEQUENCE wins, a later one on a tie, as
    // node-ical decides between two that name the same wall time.
    const chosen = new Map<number, { o: Item; rid: number; start: number }>();
    for (const o of overrides) {
      const rid = wallOf(o.recurrenceId!);
      const start = wallOf(o.start);
      if (rid < MIN_WALL || rid > MAX_WALL || start < MIN_WALL || start > MAX_WALL) continue;
      const at = instantAt(rid);
      const known = chosen.get(at);
      if (!known || o.sequence >= known.o.sequence) chosen.set(at, { o, rid, start });
    }
    for (const [at, { o, rid, start }] of chosen) {
      named.add(at);
      lines.push("BEGIN:VEVENT", "UID:s", `X-INDEX:${o.index}`, `SEQUENCE:${o.sequence}`);
      lines.push(`RECURRENCE-ID:${wallText(rid)}Z`, `DTSTART:${wallText(start)}Z`, "END:VEVENT");
      const { start: s, end: e } = this.span(o);
      longest = Math.max(longest, e - s);
    }
    lines.push("END:VCALENDAR");

    let entry: VEvent | undefined;
    try {
      entry = ical.parseICS(lines.join("\r\n")).s as VEvent | undefined;
    } catch {
      entry = undefined;
    }
    // node-ical drops a rule it can't read and keeps the first occurrence only.
    if (!entry?.rrule) return fail();

    const items = new Map([base, ...overrides].map((i) => [i.index, i]));
    const baseFields = fieldsOf(base);
    // A timed occurrence is known by the wall time its start shows, so that an
    // override keeps its occurrence's id however it names it: on the day the
    // clocks spring forward a series' 02:30 is 03:30.
    const occurrence = (wall: number) => `${key}_${allDay ? dayText(wall) : wallText(wall)}`;
    // A rule can give one instant twice: on the day the clocks spring forward an
    // hourly one gives 02:30, which isn't on the clock, and 03:30. RFC 5545
    // 3.8.5.3 counts a duplicate instance once, so the first stands. An all-day
    // occurrence is its day, however many times of it the rule gives.
    const started = new Set<number>();
    let emitted = false;
    const emit = (instance: EventInstance, wall: number) => {
      const item = items.get(Number(instance.event.INDEX));
      if (!item) return;
      if (item.recurrenceId) {
        const { start, end } = this.span(item);
        const rid = wallOf(item.recurrenceId);
        this.out.add(block(start, end, item.start.allDay, fieldsOf(item, base), occurrence(allDay ? rid : toWall(toInstant(rid, zone), zone))));
      } else {
        const day = allDay ? floorDay(wall) : wall;
        const start = instantAt(day);
        if (named.has(start) || started.has(start)) return;
        started.add(start);
        if (allDay) this.out.add(block(start, this.dayStart(day + base.end.days * DAY), true, baseFields, occurrence(day)));
        else this.out.add(block(start, endAt(base, wall, start, zone), false, baseFields, occurrence(toWall(start, zone))));
      }
      emitted = true;
    };

    // Only the window is expanded, so a rule without an end can't run away, and
    // only up to the latest start that can still make the first `limit` blocks.
    const lo = Math.max(MIN_WALL, wallAt(this.out.from) - Math.max(0, longest) - DAY);
    const hi = Math.min(MAX_WALL, wallAt(this.out.to) + DAY);
    const stop = () => Math.min(hi, Number.isFinite(this.out.cutoff) ? wallAt(this.out.cutoff) + DAY : hi);
    let a = lo;
    let chunk = Math.max(hi - lo, MIN_CHUNK_MS);
    while (a < stop()) {
      const b = Math.min(a + chunk, stop());
      let instances: EventInstance[];
      try {
        instances = expandRecurringEvent(entry, { from: new Date(a), to: new Date(b), maxIterations: MAX_ITERATIONS });
      } catch (error) {
        // Too many periods in one go: try a smaller piece of the window.
        if (chunk > MIN_CHUNK_MS && /maximum (iterations|candidate)/i.test(String((error as Error)?.message))) {
          chunk = Math.max(MIN_CHUNK_MS, Math.floor(chunk / 8));
          continue;
        }
        // The series can't be read (any further): what came back so far stays.
        if (emitted) this.skipped++;
        else fail();
        return;
      }
      for (const instance of instances) {
        const wall = instance.start.getTime();
        if (wall < a || wall >= b) continue;
        if (wall > stop()) break;
        emit(instance, wall);
      }
      a = b;
    }
  }
}

function endAt(item: Item, wall: number, start: number, zone: Zone): number {
  return item.end.days ? toInstant(wall + item.end.days * DAY, zone) + item.end.ms : start + item.end.ms;
}

/** A tag from this list, opening or closing, marks a DESCRIPTION as HTML, as Google's iCal feeds write them. */
const HTML_TAG = /<\/?(?:a|b|br|div|em|i|li|ol|p|span|strong|u|ul)(?=[\s/>])[^<>]*>/i;
/** Text values as shown, by property: an override reads its series' values without converting them again. */
const shownText = new WeakMap<Prop, string>();

/** A TEXT value as shown: unescaped, an HTML description as plain text (as for Google), trimmed. */
function textOf(prop: Prop): string {
  let value = shownText.get(prop);
  if (value === undefined) {
    value = unescapeText(prop.value);
    // htmlToText takes time in proportion to the length and never throws, whatever the markup.
    if (prop.name === "DESCRIPTION" && HTML_TAG.test(value)) value = htmlToText(value);
    value = value.trim();
    shownText.set(prop, value);
  }
  return value;
}

/**
 * What a block shows. An override without a title, place, description or CLASS
 * takes its series' own; whether it blocks time is its own.
 */
function fieldsOf(item: Item, base?: Item): Fields {
  const own = (name: string) => first(item.component, name)?.value.trim().toUpperCase();
  const prop = (name: string) => first(item.component, name) ?? (base ? first(base.component, name) : undefined);
  const text = (name: string, max: number) => {
    const p = prop(name);
    return p ? textOf(p).slice(0, max) : "";
  };
  const status = own("STATUS");
  const busyStatus = own("X-MICROSOFT-CDO-BUSYSTATUS");
  const visibility = prop("CLASS")?.value.trim().toUpperCase();
  const title = text("SUMMARY", EVENT_TEXT_LIMITS.title);
  const description = text("DESCRIPTION", EVENT_TEXT_LIMITS.description);
  const location = text("LOCATION", EVENT_TEXT_LIMITS.location);
  const details: EventDetails = { ...(description ? { description } : {}), ...(location ? { location } : {}) };
  return {
    show: status !== "CANCELLED" && own("TRANSP") !== "TRANSPARENT" && busyStatus !== "FREE",
    tentative: status === "TENTATIVE" || busyStatus === "TENTATIVE",
    private: visibility === "PRIVATE" || visibility === "CONFIDENTIAL",
    ...(title ? { title } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  };
}

function block(start: number, end: number, allDay: boolean, f: Fields, eventId: string): Busy | null {
  if (!f.show || !(end > start)) return null;
  return {
    start,
    end,
    ...(f.tentative ? { tentative: true } : {}),
    ...(allDay ? { allDay: true } : {}),
    ...(f.title ? { title: f.title } : {}),
    ...(f.private ? { private: true } : {}),
    eventId,
    ...(f.details ? { details: f.details } : {}),
  };
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const byStart = (a: Busy, b: Busy) => a.start - b.start || a.end - b.end || (a.eventId! < b.eventId! ? -1 : a.eventId! > b.eventId! ? 1 : 0);

/** Keeps the earliest `limit` blocks overlapping [from, to), and whether there were more. */
class Collector {
  /** Blocks starting after this can't be among the first `limit`. */
  cutoff = Infinity;
  private blocks: Busy[] = [];
  private truncated = false;

  constructor(
    readonly from: number,
    readonly to: number,
    private readonly limit: number,
  ) {}

  add(b: Busy | null): void {
    if (!b || !(b.start < this.to && b.end > this.from)) return;
    if (b.start > this.cutoff) {
      this.truncated = true;
      return;
    }
    this.blocks.push(b);
    if (this.blocks.length >= 2 * this.limit + 64) this.trim();
  }

  private trim(): void {
    this.blocks.sort(byStart);
    if (this.blocks.length <= this.limit) return;
    this.truncated = true;
    this.blocks.length = this.limit;
    this.cutoff = this.limit ? this.blocks[this.limit - 1].start : -Infinity;
  }

  result(): { busy: Busy[]; truncated: boolean } {
    this.trim();
    distinctIds(this.blocks);
    return { busy: this.blocks, truncated: this.truncated };
  }
}

/**
 * Ids differ between occurrences by how they are made, unless a file makes two
 * meet: a UID written like another event's occurrence id ("x_20261110T090000"),
 * or overrides of a series that isn't in the file naming one wall time in two
 * zones. Each repeat after the first, in start order, gets a suffix.
 */
function distinctIds(blocks: Busy[]): void {
  const taken = new Set<string>();
  const repeats: Busy[] = [];
  for (const b of blocks) {
    if (taken.has(b.eventId!)) repeats.push(b);
    else taken.add(b.eventId!);
  }
  const next = new Map<string, number>();
  for (const b of repeats) {
    const id = b.eventId!;
    let n = next.get(id) ?? 2;
    while (taken.has(`${id}~${n}`)) n++;
    next.set(id, n + 1);
    b.eventId = `${id}~${n}`;
    taken.add(b.eventId);
  }
}
