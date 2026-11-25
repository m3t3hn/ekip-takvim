import { afterEach, describe, expect, it, vi } from "vitest";
import { bookableSlots } from "@/lib/booking";
import {
  DAY_MS,
  MINUTE_MS,
  at,
  instants,
  random,
  reference,
  show,
  stepOf,
  wall,
  type Rule,
  type SlotsInput,
  type Span,
} from "./booking-reference";

// Booking links, criterion 3: bookableSlots, the free times a link offers.
// The expected times are worked out by hand, and checked against the
// reference in booking-reference.ts, which reads the criteria one candidate
// at a time.

const IST = "Europe/Istanbul";
const istanbul = (d: number, hour: number, min = 0) => at(IST, 2026, 11, d, hour, min); // 2026-11-16 is a Monday
const WEEKDAYS = [1, 2, 3, 4, 5];

const rule = (r: Partial<Rule> = {}): Rule => ({
  durationMin: 30,
  days: WEEKDAYS,
  startMin: 10 * 60,
  endMin: 12 * 60,
  bufferMin: 0,
  noticeMin: 0,
  aheadDays: 1,
  maxPerDay: null,
  ...r,
});

function input(i: Partial<SlotsInput> & { rule: Rule }): SlotsInput {
  return { zone: IST, now: istanbul(16, 8), until: istanbul(16, 8) + 60 * DAY_MS, busy: [], booked: [], ...i };
}

/** What bookableSlots offers, as wall-clock times in the input's zone; checks the shape on the way. */
function offered(i: SlotsInput): string[] {
  const slots = bookableSlots(i);
  for (const s of slots) {
    expect(Object.keys(s).sort()).toEqual(["end", "start"]);
    expect(s.end - s.start).toBe(i.rule.durationMin * MINUTE_MS);
  }
  return slots.map((s) => show(s.start, i.zone).slice(0, 16));
}

/** Times on one day, as offered() writes them. */
const on = (day: string, ...times: string[]) => times.map((t) => `${day} ${t}`);

/** bookableSlots against the reference: every time it offers is allowed, every time it must offer is there, in order. */
function agrees(i: SlotsInput, label = "") {
  const slots = bookableSlots(i);
  const starts = slots.map((s) => s.start);
  const { must, may } = reference(i);
  const where = (t: number) => `${label} ${show(t, i.zone)}`;
  for (let k = 1; k < starts.length; k++) {
    expect(starts[k], `ascending, no repeats: ${where(starts[k])}`).toBeGreaterThan(starts[k - 1]);
  }
  for (const s of slots) expect(s.end - s.start, where(s.start)).toBe(i.rule.durationMin * MINUTE_MS);
  const allowed = new Set(may);
  const extra = starts.filter((t) => !allowed.has(t)).map(where);
  const offeredSet = new Set(starts);
  const missing = must.filter((t) => !offeredSet.has(t)).map(where);
  expect({ extra, missing }, label).toEqual({ extra: [], missing: [] });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the criteria's example", () => {
  const example = (bufferMin: number) =>
    input({ rule: rule({ bufferMin }), busy: [{ start: istanbul(16, 10, 30), end: istanbul(16, 11) }] });

  it("offers 10:00, 11:00 and 11:30, each 30 minutes long", () => {
    expect(bookableSlots(example(0))).toEqual([
      { start: istanbul(16, 10), end: istanbul(16, 10, 30) },
      { start: istanbul(16, 11), end: istanbul(16, 11, 30) },
      { start: istanbul(16, 11, 30), end: istanbul(16, 12) },
    ]);
    agrees(example(0));
  });

  it("offers only 11:30 with a 15-minute buffer", () => {
    expect(bookableSlots(example(15))).toEqual([{ start: istanbul(16, 11, 30), end: istanbul(16, 12) }]);
    agrees(example(15));
  });
});

describe("(b) the times on a day", () => {
  it("steps 15 minutes for a 15-minute length and 30 minutes for every other", () => {
    const day = "2026-11-16";
    expect(offered(input({ rule: rule({ durationMin: 15, endMin: 11 * 60 }) }))).toEqual(on(day, "10:00", "10:15", "10:30", "10:45"));
    expect(offered(input({ rule: rule({ durationMin: 30 }) }))).toEqual(on(day, "10:00", "10:30", "11:00", "11:30"));
    expect(offered(input({ rule: rule({ durationMin: 45 }) }))).toEqual(on(day, "10:00", "10:30", "11:00"));
    expect(offered(input({ rule: rule({ durationMin: 60 }) }))).toEqual(on(day, "10:00", "10:30", "11:00"));
    expect(offered(input({ rule: rule({ durationMin: 90 }) }))).toEqual(on(day, "10:00", "10:30"));
    expect(offered(input({ rule: rule({ durationMin: 120 }) }))).toEqual(on(day, "10:00"));
    expect(offered(input({ rule: rule({ durationMin: 120, endMin: 11 * 60 + 45 }) }))).toEqual([]);
  });

  it("counts the steps from the window's start, not from the hour", () => {
    const day = "2026-11-16";
    expect(offered(input({ rule: rule({ startMin: 10 * 60 + 15 }) }))).toEqual(on(day, "10:15", "10:45", "11:15"));
    expect(offered(input({ rule: rule({ durationMin: 15, startMin: 10 * 60 + 15, endMin: 11 * 60 }) }))).toEqual(
      on(day, "10:15", "10:30", "10:45"),
    );
    expect(offered(input({ rule: rule({ durationMin: 45, startMin: 9 * 60 + 45, endMin: 11 * 60 }) }))).toEqual(on(day, "09:45", "10:15"));
  });

  it("runs the whole day for a 0 to 1440 window, the last time ending at midnight", () => {
    const i = input({ now: istanbul(15, 23), rule: rule({ durationMin: 120, days: [1], startMin: 0, endMin: 1440, aheadDays: 2 }) });
    const times = offered(i);
    expect(times).toHaveLength(45);
    expect(times[0]).toBe("2026-11-16 00:00");
    expect(times[44]).toBe("2026-11-16 22:00");
    expect(bookableSlots(i).at(-1)!.end).toBe(istanbul(17, 0));
    agrees(i);
  });
});

describe("(a) the days", () => {
  it("starts on the day of now, in the zone, and runs aheadDays days", () => {
    // Monday 23:00: Monday's window is over, Tuesday is the second of two days.
    expect(offered(input({ now: istanbul(16, 23), rule: rule({ aheadDays: 2 }) }))).toEqual(on("2026-11-17", "10:00", "10:30", "11:00", "11:30"));
    expect(offered(input({ rule: rule({ aheadDays: 1 }) }))).toEqual(on("2026-11-16", "10:00", "10:30", "11:00", "11:30"));
    const three = offered(input({ rule: rule({ aheadDays: 3 }) }));
    expect(three.map((t) => t.slice(0, 10))).toEqual([...Array(4).fill("2026-11-16"), ...Array(4).fill("2026-11-17"), ...Array(4).fill("2026-11-18")]);
  });

  it("takes the day of now on the zone's clock, not UTC's", () => {
    // 2026-11-16 22:30 UTC is Tuesday 01:30 in Istanbul.
    const now = Date.UTC(2026, 10, 16, 22, 30);
    expect(offered(input({ now, rule: rule({ aheadDays: 1 }) }))).toEqual(on("2026-11-17", "10:00", "10:30", "11:00", "11:30"));
  });

  it("keeps only the listed weekdays, 0 being Sunday", () => {
    const friday = istanbul(20, 8);
    const sundays = offered(input({ now: friday, rule: rule({ days: [0], aheadDays: 7 }) }));
    expect(sundays).toEqual(on("2026-11-22", "10:00", "10:30", "11:00", "11:30"));
    const weekend = offered(input({ now: friday, rule: rule({ days: [6, 0], aheadDays: 7, endMin: 11 * 60 }) }));
    expect(weekend).toEqual([...on("2026-11-21", "10:00", "10:30"), ...on("2026-11-22", "10:00", "10:30")]);
    expect(offered(input({ now: friday, rule: rule({ days: [3], aheadDays: 5 }) }))).toEqual([]);
    expect(offered(input({ now: friday, rule: rule({ days: [3], aheadDays: 6 }) }))).toEqual(on("2026-11-25", "10:00", "10:30", "11:00", "11:30"));
  });
});

describe("(c) notice and the end of the synced data", () => {
  it("offers nothing that starts sooner than the notice, a start exactly at it included", () => {
    const at8 = { rule: rule({ startMin: 9 * 60, noticeMin: 120 }) };
    expect(offered(input({ ...at8, now: istanbul(16, 8) }))).toEqual(on("2026-11-16", "10:00", "10:30", "11:00", "11:30"));
    expect(offered(input({ ...at8, now: istanbul(16, 8, 10) }))).toEqual(on("2026-11-16", "10:30", "11:00", "11:30"));
    expect(offered(input({ rule: rule({ noticeMin: 1440, aheadDays: 2 }) }))).toEqual(on("2026-11-17", "10:00", "10:30", "11:00", "11:30"));
  });

  it("offers nothing that ends after until, an end exactly at it included", () => {
    expect(offered(input({ rule: rule(), until: istanbul(16, 11, 30) }))).toEqual(on("2026-11-16", "10:00", "10:30", "11:00"));
    expect(offered(input({ rule: rule(), until: istanbul(16, 11, 29) }))).toEqual(on("2026-11-16", "10:00", "10:30"));
    expect(offered(input({ rule: rule({ aheadDays: 5 }), until: istanbul(17, 10, 30) }))).toEqual([
      ...on("2026-11-16", "10:00", "10:30", "11:00", "11:30"),
      ...on("2026-11-17", "10:00"),
    ]);
  });
});

describe("(d) busy blocks, bookings and the buffer", () => {
  const window9to13 = (r: Partial<Rule> = {}) => rule({ startMin: 9 * 60, endMin: 13 * 60, ...r });

  it("treats ranges as half-open: a block that only touches a time doesn't take it", () => {
    const busy = [{ start: istanbul(16, 10), end: istanbul(16, 10, 30) }];
    expect(offered(input({ rule: window9to13(), busy }))).toEqual(
      on("2026-11-16", "09:00", "09:30", "10:30", "11:00", "11:30", "12:00", "12:30"),
    );
    // With a 5-minute buffer the neighbours are taken too.
    expect(offered(input({ rule: window9to13({ bufferMin: 5 }), busy }))).toEqual(on("2026-11-16", "09:00", "11:00", "11:30", "12:00", "12:30"));
  });

  it("keeps the buffer on both sides of a time, against busy blocks", () => {
    const busy = [{ start: istanbul(16, 11), end: istanbul(16, 11, 30) }];
    // 10:30 would touch the block on its end side, 11:30 on its start side.
    expect(offered(input({ rule: window9to13({ bufferMin: 15 }), busy }))).toEqual(on("2026-11-16", "09:00", "09:30", "10:00", "12:00", "12:30"));
    // With 30 minutes, 10:00 and 12:00 only touch it.
    expect(offered(input({ rule: window9to13({ bufferMin: 30 }), busy }))).toEqual(on("2026-11-16", "09:00", "09:30", "10:00", "12:00", "12:30"));
    expect(offered(input({ rule: window9to13({ bufferMin: 30 }), busy: [{ start: istanbul(16, 11), end: istanbul(16, 11, 31) }] }))).toEqual(
      on("2026-11-16", "09:00", "09:30", "10:00", "12:30"),
    );
  });

  it("keeps the buffer on both sides against bookings too, on this link or another", () => {
    for (const here of [true, false]) {
      const booked = [{ start: istanbul(16, 11), end: istanbul(16, 11, 30), here }];
      expect(offered(input({ rule: window9to13({ bufferMin: 15 }), booked })), String(here)).toEqual(
        on("2026-11-16", "09:00", "09:30", "10:00", "12:00", "12:30"),
      );
      expect(offered(input({ rule: window9to13(), booked })), String(here)).toEqual(
        on("2026-11-16", "09:00", "09:30", "10:00", "10:30", "11:30", "12:00", "12:30"),
      );
    }
  });

  it("takes any time a block overlaps, long or short, sorted or not", () => {
    const busy = [
      { start: istanbul(16, 12, 40), end: istanbul(16, 12, 41) },
      { start: istanbul(15, 9), end: istanbul(16, 9, 31) },
      { start: istanbul(16, 10, 59), end: istanbul(16, 11, 1) },
    ];
    // 09:00 and 09:30 by the first, 10:30 and 11:00 by the second, 12:30 by the third.
    expect(offered(input({ rule: window9to13(), busy }))).toEqual(on("2026-11-16", "10:00", "11:30", "12:00"));
  });
});

describe("(e) bookings per day", () => {
  const twoDays = (maxPerDay: number | null) => rule({ aheadDays: 2, maxPerDay });
  // Outside the window, so they take no time themselves.
  const tuesdayAt = (hour: number, here: boolean) => ({ start: istanbul(17, hour), end: istanbul(17, hour, 30), here });
  const monday = on("2026-11-16", "10:00", "10:30", "11:00", "11:30");
  const tuesday = on("2026-11-17", "10:00", "10:30", "11:00", "11:30");

  it("offers nothing more on a day with maxPerDay bookings on this link", () => {
    const booked = [tuesdayAt(14, true), tuesdayAt(15, true)];
    expect(offered(input({ rule: twoDays(2), booked }))).toEqual(monday);
    expect(offered(input({ rule: twoDays(3), booked }))).toEqual([...monday, ...tuesday]);
    expect(offered(input({ rule: twoDays(null), booked: [8, 9, 14, 15, 16].map((h) => tuesdayAt(h, true)) }))).toEqual([...monday, ...tuesday]);
  });

  it("counts only this link's bookings", () => {
    const booked = [tuesdayAt(14, false), tuesdayAt(15, false), tuesdayAt(16, true)];
    expect(offered(input({ rule: twoDays(2), booked }))).toEqual([...monday, ...tuesday]);
    expect(offered(input({ rule: twoDays(1), booked }))).toEqual(monday);
  });

  it("counts a booking on the day it starts in the zone", () => {
    // 2026-11-16 21:30 UTC is Tuesday 00:30 in Istanbul.
    const booked = [{ start: Date.UTC(2026, 10, 16, 21, 30), end: Date.UTC(2026, 10, 16, 22), here: true }];
    expect(offered(input({ rule: twoDays(1), booked }))).toEqual(monday);
  });
});

describe("clock changes", () => {
  // The expected instants are worked out by hand from the zones' rules.
  const london = (spec: Partial<Rule>, now: number) => input({ zone: "Europe/London", now, until: now + 30 * DAY_MS, rule: rule(spec) });

  it("Europe/London, 2026-03-29: no time in the skipped hour, nothing twice", () => {
    const i = london({ days: [0], startMin: 0, endMin: 4 * 60, aheadDays: 2 }, Date.UTC(2026, 2, 28, 12));
    expect(bookableSlots(i).map((s) => s.start)).toEqual([0, 30, 60, 90, 120, 150].map((m) => Date.UTC(2026, 2, 29, 0, m)));
    expect(offered(i)).toEqual(on("2026-03-29", "00:00", "00:30", "02:00", "02:30", "03:00", "03:30"));
    agrees(i);
    // Daytime, an hour ahead of UTC.
    const day = london({ days: [0], startMin: 9 * 60, endMin: 10 * 60, aheadDays: 2 }, Date.UTC(2026, 2, 28, 12));
    expect(bookableSlots(day).map((s) => s.start)).toEqual([Date.UTC(2026, 2, 29, 8), Date.UTC(2026, 2, 29, 8, 30)]);
  });

  it("Europe/London, 2026-10-25: daytime on the clock after the change", () => {
    const i = london({ days: [0], startMin: 9 * 60, endMin: 11 * 60, aheadDays: 2 }, Date.UTC(2026, 9, 24, 12));
    expect(bookableSlots(i).map((s) => s.start)).toEqual([0, 30, 60, 90].map((m) => Date.UTC(2026, 9, 25, 9, m)));
    agrees(i);
  });

  it("Europe/London, 2026-10-25: the repeated hour is offered, in order, without repeats", () => {
    const i = london({ days: [0], startMin: 0, endMin: 3 * 60, aheadDays: 2 }, Date.UTC(2026, 9, 24, 12));
    const starts = bookableSlots(i).map((s) => s.start);
    const z = (h: number, m = 0, d = 25) => Date.UTC(2026, 9, d, h, m);
    // 00:00 and 00:30 BST, then 01:00 and 01:30 (BST or GMT, or both), then 02:00 and 02:30 GMT.
    expect(starts).toEqual(expect.arrayContaining([z(23, 0, 24), z(23, 30, 24), z(2), z(2, 30)]));
    for (const t of starts) expect([z(23, 0, 24), z(23, 30, 24), z(0), z(0, 30), z(1), z(1, 30), z(2), z(2, 30)]).toContain(t);
    const clock = offered(i).map((t) => t.slice(11));
    expect(clock).toEqual(expect.arrayContaining(["01:00", "01:30"]));
    agrees(i);
  });

  it("America/New_York, 2026-03-08 and 2026-11-01", () => {
    const ny = (spec: Partial<Rule>, now: number) => input({ zone: "America/New_York", now, until: now + 30 * DAY_MS, rule: rule(spec) });
    const spring = ny({ durationMin: 60, days: [0], startMin: 60, endMin: 4 * 60, aheadDays: 2 }, Date.UTC(2026, 2, 7, 12));
    // 01:00 and 01:30 EST, then 03:00 EDT; 02:00 and 02:30 don't exist.
    expect(bookableSlots(spring).map((s) => s.start)).toEqual([Date.UTC(2026, 2, 8, 6), Date.UTC(2026, 2, 8, 6, 30), Date.UTC(2026, 2, 8, 7)]);
    agrees(spring);
    const springDay = ny({ days: [0], startMin: 9 * 60, endMin: 10 * 60, aheadDays: 2 }, Date.UTC(2026, 2, 7, 12));
    expect(bookableSlots(springDay).map((s) => s.start)).toEqual([Date.UTC(2026, 2, 8, 13), Date.UTC(2026, 2, 8, 13, 30)]);
    const autumnDay = ny({ days: [0], startMin: 9 * 60, endMin: 10 * 60, aheadDays: 2 }, Date.UTC(2026, 9, 31, 12));
    expect(bookableSlots(autumnDay).map((s) => s.start)).toEqual([Date.UTC(2026, 10, 1, 14), Date.UTC(2026, 10, 1, 14, 30)]);
    agrees(autumnDay);
  });

  it("Australia/Lord_Howe, a 30-minute change: 2026-10-04 and 2026-04-05", () => {
    const lh = (spec: Partial<Rule>, now: number) => input({ zone: "Australia/Lord_Howe", now, until: now + 30 * DAY_MS, rule: rule(spec) });
    // 02:00 and 02:15 don't exist: the clock goes from 02:00 to 02:30.
    const spring = lh({ durationMin: 15, days: [0], startMin: 60, endMin: 4 * 60, aheadDays: 2 }, Date.UTC(2026, 9, 3, 2));
    expect(offered(spring)).toEqual(
      on("2026-10-04", "01:00", "01:15", "01:30", "01:45", "02:30", "02:45", "03:00", "03:15", "03:30", "03:45"),
    );
    expect(bookableSlots(spring).map((s) => s.start)).toEqual([0, 15, 30, 45, 60, 75, 90, 105, 120, 135].map((m) => Date.UTC(2026, 9, 3, 14, 30 + m)));
    agrees(spring);
    const autumnDay = lh({ days: [0], startMin: 9 * 60, endMin: 10 * 60, aheadDays: 2 }, Date.UTC(2026, 3, 4, 2));
    expect(bookableSlots(autumnDay).map((s) => s.start)).toEqual([Date.UTC(2026, 3, 4, 22, 30), Date.UTC(2026, 3, 4, 23)]);
    agrees(autumnDay);
  });

  it("America/Santiago, 2026-09-06, a day with no midnight", () => {
    const cl = (spec: Partial<Rule>, now: number) => input({ zone: "America/Santiago", now, until: now + 30 * DAY_MS, rule: rule(spec) });
    // The clock goes from 00:00 to 01:00, so the day starts at 01:00 (-03).
    const sunday = cl({ days: [0], startMin: 0, endMin: 2 * 60, aheadDays: 3 }, Date.UTC(2026, 8, 4, 12));
    expect(offered(sunday)).toEqual(on("2026-09-06", "01:00", "01:30"));
    expect(bookableSlots(sunday).map((s) => s.start)).toEqual([Date.UTC(2026, 8, 6, 4), Date.UTC(2026, 8, 6, 4, 30)]);
    agrees(sunday);
    // Saturday's window runs to midnight, which comes at 04:00 UTC.
    const saturday = cl({ days: [6], startMin: 22 * 60, endMin: 1440, aheadDays: 3 }, Date.UTC(2026, 8, 4, 12));
    expect(bookableSlots(saturday).map((s) => s.start)).toEqual([0, 30, 60, 90].map((m) => Date.UTC(2026, 8, 6, 2, m)));
    expect(bookableSlots(saturday).at(-1)!.end).toBe(Date.UTC(2026, 8, 6, 4));
    agrees(saturday);
  });
});

describe("against the reference, on random inputs", () => {
  // Clock changes in 2026 (from the zones' rules), to start near; and zones without one.
  const CHANGES: Record<string, string[]> = {
    "Europe/London": ["2026-03-29T01:00Z", "2026-10-25T01:00Z"],
    "America/New_York": ["2026-03-08T07:00Z", "2026-11-01T06:00Z"],
    "Australia/Lord_Howe": ["2026-04-04T15:00Z", "2026-10-03T15:30Z"],
    "America/Santiago": ["2026-04-05T03:00Z", "2026-09-06T04:00Z"],
    "America/Havana": ["2026-03-08T05:00Z", "2026-11-01T05:00Z"],
    "Asia/Beirut": ["2026-03-28T22:00Z", "2026-10-24T21:00Z"],
    "Africa/Casablanca": ["2026-02-15T02:00Z", "2026-03-22T02:00Z"],
    "Pacific/Chatham": ["2026-04-04T14:00Z", "2026-09-26T14:00Z"],
    "America/St_Johns": ["2026-03-08T05:30Z", "2026-11-01T04:30Z"],
    "Europe/Istanbul": [],
    "Asia/Kathmandu": [],
    "Pacific/Kiritimati": [],
    "Pacific/Pago_Pago": [],
    UTC: [],
  };
  const ZONES = Object.keys(CHANGES);
  const DURATIONS = [15, 30, 45, 60, 90, 120];
  const BUFFERS = [0, 5, 10, 15, 30];
  const NOTICES = [0, 60, 120, 240, 720, 1440, 2880];

  function randomInput(next: () => number): SlotsInput {
    const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    const zone = pick(ZONES);
    const changes = CHANGES[zone];
    const base = changes.length && next() < 0.7 ? Date.parse(pick(changes)) - int(0, 4) * DAY_MS : Date.UTC(2026, 0, 1) + int(0, 364) * DAY_MS;
    const now = base + int(0, 24 * 60 - 1) * MINUTE_MS + (next() < 0.3 ? int(1, 59_999) : 0);
    const durationMin = pick(DURATIONS);
    // Clocks change at night, so many windows are at night, or run to midnight.
    const shape = next();
    const startMin =
      shape < 0.35 ? int(0, 12) * 15 : shape < 0.5 ? int(80, (1440 - durationMin) / 15) * 15 : int(0, (1440 - durationMin) / 15) * 15;
    const endMin =
      shape < 0.35
        ? Math.min(1440, int((startMin + durationMin) / 15, 28) * 15)
        : shape < 0.5
          ? 1440
          : int((startMin + durationMin) / 15, 96) * 15;
    const days = [0, 1, 2, 3, 4, 5, 6].filter(() => next() < 0.7);
    const r: Rule = {
      durationMin,
      days: days.length ? days : [int(0, 6)],
      startMin,
      endMin,
      bufferMin: pick(BUFFERS),
      noticeMin: pick(NOTICES),
      aheadDays: int(1, 8),
      maxPerDay: next() < 0.5 ? null : int(1, 3),
    };
    const span = (r.aheadDays + 2) * DAY_MS;
    const from = now - DAY_MS;
    const grid = (step: number) => Math.floor((from + next() * span) / (step * MINUTE_MS)) * step * MINUTE_MS;
    const busy: Span[] = Array.from({ length: int(0, 14) }, () => {
      const start = next() < 0.5 ? grid(15) : grid(5);
      return { start, end: start + int(1, 60) * 5 * MINUTE_MS };
    });
    const booked = Array.from({ length: int(0, 8) }, () => {
      const start = grid(15);
      return { start, end: start + pick(DURATIONS) * MINUTE_MS, here: next() < 0.6 };
    });
    const until = next() < 0.5 ? now + 400 * DAY_MS : Math.floor((now + next() * span) / (15 * MINUTE_MS)) * 15 * MINUTE_MS;
    return { rule: r, zone, now, until, busy, booked };
  }

  it("matches on 1500 inputs in 14 zones, near clock changes and not", () => {
    const next = random(20261118);
    let times = 0;
    for (let n = 0; n < 1500; n++) {
      const i = randomInput(next);
      agrees(i, `case ${n} ${JSON.stringify(i)}`);
      times += bookableSlots(i).length;
    }
    // The inputs aren't all empty.
    expect(times).toBeGreaterThan(10_000);
  });

  it("on clock-change days, never offers a wall-clock time twice or one off its steps", () => {
    const next = random(7);
    for (let n = 0; n < 200; n++) {
      const i = randomInput(next);
      if (!CHANGES[i.zone].length) continue;
      const seen = new Set<string>();
      for (const s of bookableSlots(i)) {
        const w = wall(s.start, i.zone);
        const key = `${w.y}-${w.m}-${w.d} ${w.minute}`;
        const label = `case ${n} ${show(s.start, i.zone)} ${JSON.stringify(i)}`;
        expect(w.minute >= i.rule.startMin && (w.minute - i.rule.startMin) % stepOf(i.rule.durationMin) === 0, label).toBe(true);
        expect(i.rule.days, label).toContain(w.weekday);
        // Only a wall-clock time the clock repeats may come twice, as its two instants.
        if (seen.has(key)) expect(instants(w, w.minute, i.zone), label).toHaveLength(2);
        seen.add(key);
      }
    }
  });
});

describe("a pure function", () => {
  it("reads nothing but its input: not the clock, and it changes nothing it is given", () => {
    const deepFreeze = <T,>(o: T): T => {
      for (const v of Object.values(o as object)) if (v && typeof v === "object") deepFreeze(v);
      return Object.freeze(o);
    };
    const i = deepFreeze(
      input({
        rule: rule({ aheadDays: 3, bufferMin: 10, maxPerDay: 2 }),
        busy: [{ start: istanbul(17, 10, 30), end: istanbul(17, 11) }],
        booked: [{ start: istanbul(18, 11), end: istanbul(18, 11, 30), here: true }],
      }),
    );
    const first = bookableSlots(i);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2031, 0, 1));
    expect(bookableSlots(i)).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});
