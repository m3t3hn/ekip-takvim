import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offeredTimes } from "@/lib/booking";
import { byDay, TimeList } from "@/app/book/[id]/booking-page";
import { DAY_MS, MINUTE_MS, at, random, reference, show, wall, type Rule, type SlotsInput, type Span } from "./booking-reference";
import { dayIn, fullVerdicts, plainFullDays, visitorDays } from "./booking-days-reference";
import { all, byTag, render, textOf } from "./booking-html";
import { LINK, bookingApp, type Page } from "./booking-helpers";

// Booking links' quick wins (run 2026-11-25-ekip-quick-wins-visitor),
// criterion 3: full days are shown as full.
// - A day the link offers (one of its weekdays, within its days ahead, with a
//   time its hours and notice allow) with no time free is listed in its
//   place, in date order, as "Fully booked", with no time buttons.
// - Other weekdays, days past its days ahead and today once the notice has
//   passed its last time stay out. With no free time at all: no days.
// - Nothing more about the host: not why, no busy time.
// - On the visitor's clock: a full day on the visitor's day of its first
//   time, and never on a visitor's day that has free times.
// Written from the criteria; booking-days-reference.ts states them again.
// The page's list is TimeList, rendered with react-dom/server.

const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "f".repeat(40);
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.DEMO_MODE = "true";
process.env.APP_URL = "https://cal.example.com";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const app = await bookingApp(jar);
const { db } = app;

const IST = "Europe/Istanbul";
const LA = "America/Los_Angeles";
const BERLIN = "Europe/Berlin";
/** 2026-11-<d> at hh:mm in Istanbul (UTC+3). 2026-11-18 is a Wednesday. */
const ist = (d: number, h: number, m = 0) => at(IST, 2026, 11, d, h, m);
const NOW = ist(18, 9);
const MIN = MINUTE_MS;

const rule = (r: Partial<Rule> = {}): Rule => ({
  durationMin: 30,
  days: [1, 2, 3, 4, 5],
  startMin: 600,
  endMin: 720,
  bufferMin: 0,
  noticeMin: 0,
  aheadDays: 6,
  maxPerDay: null,
  ...r,
});
const input = (i: Partial<SlotsInput> = {}): SlotsInput => ({
  rule: rule(),
  zone: IST,
  now: NOW,
  until: NOW + 30 * DAY_MS,
  busy: [],
  booked: [],
  ...i,
});
/** A whole 10:00-12:00 window busy on 2026-11-<d> in Istanbul. */
const busyDay = (d: number): Span => ({ start: ist(d, 10), end: ist(d, 12) });

/** offeredTimes' full days, as wall-clock times in the input's zone. */
const fullOf = (i: SlotsInput) => offeredTimes(i).full.map((t) => show(t, i.zone).slice(0, 16));
/** What a visitor sees from offeredTimes' answer: each day's heading and whether it's full. */
const listed = (i: SlotsInput, zone: string) =>
  byDay(offeredTimes(i).slots, offeredTimes(i).full, zone).map((d) => `${d.day} ${d.full ? "full" : d.slots.length}`);

function setNow(t: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
}
afterEach(() => {
  vi.useRealTimers();
});

describe("which days are full (offeredTimes)", () => {
  it("lists a day the host is busy for as full, at its first time, and keeps its free times as before", () => {
    const i = input({ busy: [busyDay(19)] });
    const { slots, full } = offeredTimes(i);
    expect(full).toEqual([ist(19, 10)]);
    expect(fullOf(i)).toEqual(["2026-11-19 10:00"]);
    // The free times are the rule's, as before: Wednesday, Friday and Monday.
    expect(slots.map((s) => s.start)).toEqual(reference(i).must);
    expect(slots.map((s) => show(s.start, IST).slice(0, 10))).toEqual([
      ...Array(4).fill("2026-11-18"),
      ...Array(4).fill("2026-11-20"),
      ...Array(4).fill("2026-11-23"),
    ]);
    expect(plainFullDays(i)).toEqual(full);
  });

  it("lists a day that reached its bookings per day as full: bookings on this link count, others don't", () => {
    const here = { start: ist(20, 10, 30), end: ist(20, 11), here: true };
    const elsewhere = { start: ist(19, 11), end: ist(19, 11, 30), here: false };
    const i = input({ rule: rule({ maxPerDay: 1 }), booked: [here, elsewhere] });
    // Friday has its one booking here: full, at its first time (10:00, not the booking's).
    expect(offeredTimes(i).full).toEqual([ist(20, 10)]);
    // Thursday's booking is on another link: Thursday only loses that time.
    expect(offeredTimes(i).slots.filter((s) => dayIn(s.start, IST) === "2026-11-19").map((s) => s.start)).toEqual([
      ist(19, 10),
      ist(19, 10, 30),
      ist(19, 11, 30),
    ]);
    expect(plainFullDays(i)).toEqual([ist(20, 10)]);
  });

  it("lists days full for either reason in date order", () => {
    const i = input({
      rule: rule({ maxPerDay: 2 }),
      busy: [busyDay(23)],
      booked: [
        { start: ist(19, 10), end: ist(19, 10, 30), here: true },
        { start: ist(19, 11), end: ist(19, 11, 30), here: true },
      ],
    });
    expect(fullOf(i)).toEqual(["2026-11-19 10:00", "2026-11-23 10:00"]);
    expect(offeredTimes(i).full).toEqual(plainFullDays(i));
  });

  it("says nothing of why or of the busy times: a day's entry is the same whatever makes it full", () => {
    const ways: [string, Partial<SlotsInput>][] = [
      ["busy for the window", { busy: [busyDay(19)] }],
      ["busy for longer", { busy: [{ start: ist(19, 7, 13), end: ist(19, 15, 41) }] }],
      ["four meetings", { busy: [10, 10.5, 11, 11.5].map((h) => ({ start: ist(19, Math.floor(h), (h % 1) * 60), end: ist(19, Math.floor(h), (h % 1) * 60) + 30 * MIN })) }],
      ["an odd block with the break around it", { rule: rule({ bufferMin: 15 }), busy: [{ start: ist(19, 10, 7), end: ist(19, 11, 52) }] }],
      ["its bookings per day", { rule: rule({ maxPerDay: 2 }), booked: [ist(19, 10, 30), ist(19, 11, 30)].map((t) => ({ start: t, end: t + 30 * MIN, here: true })) }],
      ["booked on other links", { booked: [10, 10.5, 11, 11.5].map((h) => ({ start: ist(19, Math.floor(h), (h % 1) * 60), end: ist(19, Math.floor(h), (h % 1) * 60) + 30 * MIN, here: false })) }],
    ];
    for (const [why, i] of ways) {
      const { slots, full } = offeredTimes(input(i));
      expect(full, why).toEqual([ist(19, 10)]);
      expect(slots, why).toEqual(offeredTimes(input()).slots.filter((s) => dayIn(s.start, IST) !== "2026-11-19"));
    }
  });

  it("leaves out the days the link doesn't offer: other weekdays, past its days ahead, past the synced days", () => {
    // Saturday and Sunday are busy, but the link doesn't offer them.
    expect(fullOf(input({ busy: [busyDay(21), busyDay(22)] }))).toEqual([]);
    // Mondays, Wednesdays and Fridays only: a busy Thursday isn't a day it offers.
    expect(fullOf(input({ rule: rule({ days: [1, 3, 5] }), busy: [busyDay(19)] }))).toEqual([]);
    // Two days ahead (Wednesday, Thursday): a busy Friday is past them.
    const twoDays = input({ rule: rule({ aheadDays: 2 }), busy: [busyDay(20)] });
    expect(fullOf(twoDays)).toEqual([]);
    expect(offeredTimes(twoDays).slots.map((s) => dayIn(s.start, IST))).not.toContain("2026-11-20");
    // The synced days end on Thursday night: Friday isn't offered, busy or not.
    const synced = input({ until: ist(20, 0), busy: [busyDay(20)] });
    expect(fullOf(synced)).toEqual([]);
    expect(fullOf({ ...synced, busy: [] })).toEqual([]);
    // Up to Friday 10:45: only Friday 10:00 ends in time, and it's busy, so Friday is full.
    const shortSync = input({ until: ist(20, 10, 45), busy: [{ start: ist(20, 9), end: ist(20, 10, 30) }] });
    expect(fullOf(shortSync)).toEqual(["2026-11-20 10:00"]);
  });

  it("leaves out today once the notice has passed its last time, and lists it from its first time the notice allows", () => {
    const busyRest = { start: ist(18, 9), end: ist(18, 12) };
    // 11:45 with no notice: 11:30 has begun, so today offers nothing.
    expect(fullOf(input({ now: ist(18, 11, 45), busy: [busyRest, busyDay(19)] }))).toEqual(["2026-11-19 10:00"]);
    // 10:31 with an hour's notice: 11:30 is too soon.
    expect(fullOf(input({ now: ist(18, 10, 31), rule: rule({ noticeMin: 60 }), busy: [busyRest] }))).toEqual([]);
    // 10:29 with an hour's notice: 11:30 is allowed and busy, so today is full, from 11:30.
    const i = input({ now: ist(18, 10, 29), rule: rule({ noticeMin: 60 }), busy: [busyRest] });
    expect(fullOf(i)).toEqual(["2026-11-18 11:30"]);
    expect(offeredTimes(i).full).toEqual(plainFullDays(i));
    // Exactly at the notice: 11:30 is allowed, as a free time would be.
    expect(fullOf(input({ now: ist(18, 10, 30), rule: rule({ noticeMin: 60 }), busy: [busyRest] }))).toEqual(["2026-11-18 11:30"]);
  });

  it("lists no full day when nothing is free on the days it offers, whatever is busy (the server's part, see below)", () => {
    // offeredTimes itself lists them; linkTimes, for the page, then drops them (tested through GET below).
    const i = input({ busy: [busyDay(18), busyDay(19), busyDay(20), busyDay(23)] });
    expect(offeredTimes(i).slots).toEqual([]);
    expect(byDay(offeredTimes(i).slots, offeredTimes(i).full, IST)).toEqual([]);
  });

  it("on a day the clocks go back (Berlin, 25 Oct 2026), a busy day is full at its first time", () => {
    const berlin = (d: number, h: number, m = 0) => at(BERLIN, 2026, 10, d, h, m);
    // Fridays to Mondays, 01:00 to 04:00 Berlin time; 02:00-03:00 comes twice on Sunday the 25th.
    const i: SlotsInput = {
      rule: rule({ days: [0, 1, 5, 6], startMin: 60, endMin: 240, aheadDays: 4 }),
      zone: BERLIN,
      now: berlin(23, 12),
      until: berlin(23, 12) + 30 * DAY_MS,
      busy: [{ start: berlin(25, 0), end: berlin(25, 5) }],
      booked: [],
    };
    const verdicts = fullVerdicts(i);
    const sunday = verdicts.find((v) => v.day === "2026-10-25")!;
    expect(sunday).toMatchObject({ certain: true, possible: true, plain: false });
    expect(offeredTimes(i).full).toEqual([berlin(25, 1)]);
    // Its first time is Sunday 01:00 CEST, 23:00 UTC on Saturday.
    expect(new Date(offeredTimes(i).full[0]).toISOString()).toBe("2026-10-24T23:00:00.000Z");
  });

  it("on a day the clocks go forward (Berlin, 29 Mar 2026), a busy day is full at its first time that exists", () => {
    const berlin = (d: number, h: number, m = 0) => at(BERLIN, 2026, 3, d, h, m);
    // 02:00 to 05:00 Berlin time; on Sunday the 29th, 02:00-03:00 doesn't exist.
    const i: SlotsInput = {
      rule: rule({ days: [0, 1, 5, 6], startMin: 120, endMin: 300, aheadDays: 4 }),
      zone: BERLIN,
      now: berlin(27, 12),
      until: berlin(27, 12) + 30 * DAY_MS,
      busy: [{ start: berlin(29, 0), end: berlin(29, 6) }],
      booked: [],
    };
    expect(offeredTimes(i).full).toEqual([berlin(29, 3)]);
    expect(new Date(offeredTimes(i).full[0]).toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(fullVerdicts(i).find((v) => v.day === "2026-03-29")).toMatchObject({ certain: true, firsts: [berlin(29, 3)] });
  });
});

describe("on the visitor's clock (byDay)", () => {
  it("a visitor in Istanbul sees each host day as one day, the full one in its place", () => {
    expect(listed(input({ busy: [busyDay(19)] }), IST)).toEqual(["2026-11-18 4", "2026-11-19 full", "2026-11-20 4", "2026-11-23 4"]);
  });

  // 10:00-12:00 in Istanbul is 23:00-01:00 in Los Angeles: each host day
  // spans two of the visitor's days.
  it("far west of the host: a full day is listed on the visitor's day of its first time, if that day has no free time", () => {
    // Monday the 23rd full: its first time, 10:00 Istanbul, is 23:00 on Sunday the 22nd in LA.
    const i = input({ busy: [busyDay(23)] });
    expect(offeredTimes(i).full).toEqual([ist(23, 10)]);
    expect(show(ist(23, 10), LA)).toMatch(/^2026-11-22 23:00/);
    expect(listed(i, LA)).toEqual([
      "2026-11-17 2", // Wednesday 10:00, 10:30 in Istanbul
      "2026-11-18 4", // Wednesday 11:00, 11:30; Thursday 10:00, 10:30
      "2026-11-19 4",
      "2026-11-20 2", // Friday 11:00, 11:30
      "2026-11-22 full", // Monday's first time; Monday 11:00 and 11:30 (LA's 23rd) aren't listed
    ]);
  });

  it("far west of the host: a full day whose first time falls on a visitor's day with free times isn't shown as full", () => {
    // Thursday full: its first time is Wednesday 23:00 in LA, and LA's Wednesday has Wednesday's 11:00 and 11:30.
    const i = input({ busy: [busyDay(19)] });
    expect(offeredTimes(i).full).toEqual([ist(19, 10)]);
    expect(listed(i, LA)).toEqual(["2026-11-17 2", "2026-11-18 2", "2026-11-19 2", "2026-11-20 2", "2026-11-22 2", "2026-11-23 2"]);
    expect(listed(i, LA).some((d) => d.endsWith("full"))).toBe(false);
  });

  it("far east of the host: a host in Los Angeles, a visitor in Kiritimati (UTC+14)", () => {
    const laAt = (d: number, h: number, m = 0) => at(LA, 2026, 11, d, h, m);
    // 09:00-17:00 in LA is 07:00-15:00 the next day in Kiritimati.
    const i: SlotsInput = {
      rule: rule({ startMin: 540, endMin: 1020, aheadDays: 3 }),
      zone: LA,
      now: laAt(18, 8),
      until: laAt(18, 8) + 30 * DAY_MS,
      busy: [{ start: laAt(19, 9), end: laAt(19, 17) }],
      booked: [],
    };
    expect(offeredTimes(i).full).toEqual([laAt(19, 9)]);
    expect(listed(i, "Pacific/Kiritimati")).toEqual(["2026-11-19 16", "2026-11-20 full", "2026-11-21 16"]);
  });

  it("follows the visitor's clock change: New York's 1 Nov 2026 has 25 hours", () => {
    // A host in UTC, every day 00:00-24:00, an hour long (a time every 30 minutes); 31 Oct to 2 Nov.
    const i: SlotsInput = {
      rule: rule({ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440, durationMin: 60, aheadDays: 3 }),
      zone: "UTC",
      now: Date.UTC(2026, 9, 31),
      until: Date.UTC(2026, 10, 30),
      // 1 Nov (UTC) busy all day: its first time, 00:00 UTC, is 20:00 on 31 Oct in New York, which has free times.
      busy: [{ start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 2) }],
      booked: [],
    };
    expect(offeredTimes(i).full).toEqual([Date.UTC(2026, 10, 1)]);
    const days = byDay(offeredTimes(i).slots, offeredTimes(i).full, "America/New_York");
    // 31 Oct's times, 00:00-23:00 UTC, are 30 Oct 20:00-23:30 and 31 Oct 00:00-19:00 EDT (UTC-4).
    // 2 Nov's, after the change, are 1 Nov 19:00-23:30 and 2 Nov 00:00-18:00 EST (UTC-5): at UTC-4
    // throughout, 1 Nov would get 8 of them, not 10.
    expect(days.map((d) => `${d.day} ${d.full ? "full" : d.slots.length}`)).toEqual(["2026-10-30 8", "2026-10-31 39", "2026-11-01 10", "2026-11-02 37"]);
    expect(days).toEqual(
      visitorDays(offeredTimes(i).slots, offeredTimes(i).full, "America/New_York").map((d) => ({
        day: d.day,
        full: d.full,
        slots: d.slots.map((start) => ({ start, end: start + 60 * MIN })),
      })),
    );
  });

  it("with no free time at all, lists nothing, full days given or not", () => {
    expect(byDay([], [ist(19, 10), ist(20, 10)], IST)).toEqual([]);
    expect(byDay([], [], IST)).toEqual([]);
  });

  it("lists a visitor's day once when two full host days start on it", () => {
    // Today's first time can be late (23:30, the notice) and tomorrow's early (00:00): one day for most visitors.
    const i = input({
      rule: rule({ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440, aheadDays: 3 }),
      now: ist(18, 23, 20),
      busy: [{ start: ist(18, 23), end: ist(20, 0) }],
    });
    expect(offeredTimes(i).full).toEqual([ist(18, 23, 30), ist(19, 0)]);
    // Both first times are on 18 Nov in UTC (20:30 and 21:00); Friday's times are 21:00 on the 19th to 20:30 on the 20th.
    expect(listed(i, "UTC")).toEqual(["2026-11-18 full", "2026-11-19 6", "2026-11-20 42"]);
    expect(listed(i, IST)).toEqual(["2026-11-18 full", "2026-11-19 full", "2026-11-20 48"]);
    expect(byDay([{ start: ist(18, 10), end: ist(18, 10, 30) }], [ist(19, 10), ist(19, 11)], IST).map((d) => `${d.day} ${d.full}`)).toEqual([
      "2026-11-18 false",
      "2026-11-19 true",
    ]);
  });
});

describe("against the reference, on random inputs", () => {
  const HOST_ZONES: Record<string, string[]> = {
    "Europe/Berlin": ["2026-03-29T01:00Z", "2026-10-25T01:00Z"],
    "America/New_York": ["2026-03-08T07:00Z", "2026-11-01T06:00Z"],
    "Australia/Lord_Howe": ["2026-04-04T15:00Z", "2026-10-03T15:30Z"],
    "America/Santiago": ["2026-04-05T03:00Z", "2026-09-06T04:00Z"],
    "Pacific/Chatham": ["2026-04-04T14:00Z", "2026-09-26T14:00Z"],
    "Europe/Istanbul": [],
    "Asia/Kathmandu": [],
    "Pacific/Kiritimati": [],
    "Pacific/Pago_Pago": [],
    UTC: [],
  };
  const VISITOR_ZONES = ["Europe/Istanbul", "America/Los_Angeles", "America/New_York", "Europe/London", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Australia/Lord_Howe", "UTC"];
  const DURATIONS = [15, 30, 45, 60, 90, 120];
  const BUFFERS = [0, 5, 10, 15, 30];
  const NOTICES = [0, 60, 120, 240, 720, 1440, 2880];

  function randomCase(next: () => number) {
    const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    const zones = Object.keys(HOST_ZONES);
    const zone = pick(zones);
    const changes = HOST_ZONES[zone];
    const base = changes.length && next() < 0.7 ? Date.parse(pick(changes)) - int(0, 4) * DAY_MS : Date.UTC(2026, 0, 1) + int(0, 364) * DAY_MS;
    const now = base + int(0, 24 * 60 - 1) * MINUTE_MS + (next() < 0.3 ? int(1, 59_999) : 0);
    const durationMin = pick(DURATIONS);
    const shape = next();
    const startMin =
      shape < 0.35 ? int(0, 12) * 15 : shape < 0.5 ? int(80, (1440 - durationMin) / 15) * 15 : int(0, (1440 - durationMin) / 15) * 15;
    const endMin =
      shape < 0.35 ? Math.min(1440, int((startMin + durationMin) / 15, 28) * 15) : shape < 0.5 ? 1440 : int((startMin + durationMin) / 15, 96) * 15;
    const days = [0, 1, 2, 3, 4, 5, 6].filter(() => next() < 0.7);
    const r: Rule = {
      durationMin,
      days: days.length ? days : [int(0, 6)],
      startMin,
      endMin,
      bufferMin: pick(BUFFERS),
      noticeMin: pick(NOTICES),
      aheadDays: int(1, 10),
      maxPerDay: next() < 0.5 ? null : int(1, 3),
    };
    const span = (r.aheadDays + 2) * DAY_MS;
    const from = now - DAY_MS;
    const grid = (step: number) => Math.floor((from + next() * span) / (step * MINUTE_MS)) * step * MINUTE_MS;
    const busy: Span[] = Array.from({ length: int(0, 10) }, () => {
      const start = next() < 0.5 ? grid(15) : grid(5);
      return { start, end: start + int(1, 60) * 5 * MINUTE_MS };
    });
    // Whole days busy, so some days are full: a day or two of 24 hours or more.
    for (let k = int(0, 3); k > 0; k--) {
      const start = grid(60);
      busy.push({ start, end: start + int(20, 40) * 60 * MINUTE_MS });
    }
    const booked = Array.from({ length: int(0, 10) }, () => {
      const start = grid(15);
      return { start, end: start + pick(DURATIONS) * MINUTE_MS, here: next() < 0.7 };
    });
    const until = next() < 0.6 ? now + 400 * DAY_MS : Math.floor((now + next() * span) / (15 * MINUTE_MS)) * 15 * MINUTE_MS;
    const input: SlotsInput = { rule: r, zone, now, until, busy, booked };
    return { input, visitor: pick(VISITOR_ZONES) };
  }

  type Seen = { full: number; fullOnChangeDays: number; visitorFull: number; hiddenByFreeTimes: number };

  /** offeredTimes and byDay against the reference for one input; counts what it saw. */
  function check(input: SlotsInput, visitor: string, label: string, seen: Seen) {
    const { slots, full } = offeredTimes(input);

    // The free times are bookableSlots' as before (booking-slots.test.ts holds the rest).
    const { must, may } = reference(input);
    const starts = slots.map((s) => s.start);
    const mayOffer = new Set(may);
    const offered = new Set(starts);
    expect(starts.filter((t) => !mayOffer.has(t)), `extra times: ${label}`).toEqual([]);
    expect(must.filter((t) => !offered.has(t)), `missing times: ${label}`).toEqual([]);

    // Full days: ascending, one per day, each a day the criteria may call full, at a time it may start from.
    const verdicts = new Map(fullVerdicts(input).map((v) => [v.day, v]));
    for (let k = 1; k < full.length; k++) expect(full[k], `ascending: ${label}`).toBeGreaterThan(full[k - 1]);
    const fullDaysSeen = new Set<string>();
    for (const t of full) {
      const day = dayIn(t, input.zone);
      const v = verdicts.get(day);
      const where = `${show(t, input.zone)} ${label}`;
      expect(fullDaysSeen.has(day), `two entries for one day: ${where}`).toBe(false);
      fullDaysSeen.add(day);
      expect(v?.possible, `not a full day: ${where}`).toBe(true);
      if (v!.plain) expect(t, `not its first time: ${where}`).toBe(v!.firsts[0]);
      else expect(v!.firsts, `not a first time it may have: ${where}`).toContain(t);
      if (!v!.plain) seen.fullOnChangeDays++;
    }
    for (const v of verdicts.values()) {
      if (v.certain) expect(fullDaysSeen.has(v.day), `full day missing: ${v.day} ${label}`).toBe(true);
    }
    seen.full += full.length;

    // The visitor's list, on their clock.
    const days = byDay(slots, full, visitor);
    const expected = visitorDays(slots, full, visitor);
    expect(
      days.map((d) => ({ day: d.day, full: d.full, slots: d.slots.map((s) => s.start) })),
      `visitor's list: ${label}`,
    ).toEqual(expected);
    for (const d of days) if (d.full) expect(d.slots, label).toEqual([]);
    seen.visitorFull += days.filter((d) => d.full).length;
    if (slots.length) seen.hiddenByFreeTimes += new Set(full.map((t) => dayIn(t, visitor))).size - days.filter((d) => d.full).length;
  }

  it("agrees on 1500 inputs: the free times, which days are full and their first times, and the visitor's list", () => {
    const next = random(20261125);
    const seen: Seen = { full: 0, fullOnChangeDays: 0, visitorFull: 0, hiddenByFreeTimes: 0 };
    for (let n = 0; n < 1500; n++) {
      const { input, visitor } = randomCase(next);
      check(input, visitor, `case ${n} ${JSON.stringify(input)} visitor ${visitor}`, seen);
    }
    // The inputs reach the cases the criterion names.
    expect(seen.full).toBeGreaterThan(500);
    expect(seen.visitorFull).toBeGreaterThan(300);
    expect(seen.hiddenByFreeTimes).toBeGreaterThan(20);
  });

  it("agrees on 600 inputs whose days ahead hold a clock change in the host's zone, often busy", () => {
    const next = random(1125);
    const pick = <T,>(list: T[]) => list[Math.floor(next() * list.length)];
    const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
    const zones = Object.keys(HOST_ZONES).filter((z) => HOST_ZONES[z].length);
    const seen: Seen = { full: 0, fullOnChangeDays: 0, visitorFull: 0, hiddenByFreeTimes: 0 };
    for (let n = 0; n < 600; n++) {
      const zone = pick(zones);
      const change = Date.parse(pick(HOST_ZONES[zone]));
      const now = change - int(0, 3) * DAY_MS - int(0, 23) * 60 * MINUTE_MS - (next() < 0.3 ? int(1, 59) * MINUTE_MS : 0);
      const durationMin = pick(DURATIONS);
      // A window around the change's wall-clock time, or the whole day.
      const around = wall(change, zone).minute;
      const startMin = next() < 0.4 ? 0 : Math.max(0, Math.floor((around - int(0, 180)) / 15) * 15);
      const endMin = next() < 0.4 ? 1440 : Math.min(1440, Math.max(startMin + durationMin, Math.ceil((around + int(30, 240)) / 15) * 15));
      const r: Rule = {
        durationMin,
        days: [0, 1, 2, 3, 4, 5, 6],
        startMin,
        endMin: Math.max(endMin, startMin + durationMin),
        bufferMin: pick(BUFFERS),
        noticeMin: pick([0, 0, 60, 240]),
        aheadDays: int(4, 7),
        maxPerDay: next() < 0.3 ? int(1, 2) : null,
      };
      const busy: Span[] = [];
      // The change's day busy, from well before it to well after, most times.
      if (next() < 0.75) busy.push({ start: change - int(12, 30) * 60 * MINUTE_MS, end: change + int(12, 30) * 60 * MINUTE_MS });
      for (let k = int(0, 4); k > 0; k--) {
        const start = Math.floor((now + next() * 6 * DAY_MS) / (15 * MINUTE_MS)) * 15 * MINUTE_MS;
        busy.push({ start, end: start + int(1, 24) * 15 * MINUTE_MS });
      }
      const booked = Array.from({ length: int(0, 3) }, () => {
        const start = Math.floor((change + (next() - 0.5) * DAY_MS) / (15 * MINUTE_MS)) * 15 * MINUTE_MS;
        return { start, end: start + durationMin * MINUTE_MS, here: next() < 0.8 };
      });
      const input: SlotsInput = { rule: r, zone, now, until: now + 60 * DAY_MS, busy, booked };
      const visitor = pick(VISITOR_ZONES);
      check(input, visitor, `change case ${n} ${JSON.stringify(input)} visitor ${visitor}`, seen);
    }
    expect(seen.fullOnChangeDays).toBeGreaterThan(50);
    expect(seen.full).toBeGreaterThan(300);
  });
});

describe("GET /api/book/[id]: fullDays", () => {
  beforeEach(() => {
    db.resetAll();
    app.signOut();
    setNow(NOW);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.booking-limits")];
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("test: no network");
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.BOOKING_LINKS = "on";
    process.env.CONFIG_YAML = CONFIG;
  });

  const until = () => app.sync.syncWindow(app.sync.getConfig()!).to.getTime();
  const page = async (id: string) => {
    const a = await app.page(id);
    expect(a.status, a.text).toBe(200);
    return a.json as Page & { fullDays: number[]; meet: boolean };
  };

  it("lists the host's busy day and the link's capped day, as the criteria say, and nothing else new but meet", async () => {
    // Thursday's window is busy, with odd minutes no time of the link has.
    const busy = [{ start: ist(19, 9, 47), end: ist(19, 12, 13), title: "Secret Thursday" }];
    const { id } = await app.hostWithLink({ aheadDays: 6, maxPerDay: 1 }, { busy });
    // Friday reaches its one booking.
    await app.bookAs(id, ist(20, 11));
    const body = await page(id);
    expect(Object.keys(body).sort()).toEqual(["description", "durationMin", "fullDays", "hostName", "meet", "slots", "title"]);
    expect(body.fullDays).toEqual([ist(19, 10), ist(20, 10)]);
    const booked = app.bookingRows().map((b) => ({ start: Number(b.start_ms), end: Number(b.end_ms), here: true }));
    // The link is LINK with six days ahead and at most one a day: rule({ maxPerDay: 1 }).
    const { durationMin, days, startMin, endMin, bufferMin, noticeMin } = LINK;
    expect(rule({ maxPerDay: 1 })).toEqual({ durationMin, days, startMin, endMin, bufferMin, noticeMin, aheadDays: 6, maxPerDay: 1 });
    const i: SlotsInput = { rule: rule({ maxPerDay: 1 }), zone: IST, now: NOW, until: until(), busy, booked };
    expect(body.fullDays).toEqual(plainFullDays(i));
    expect(body.slots.map((s) => s.start)).toEqual(reference(i).must);
    // Nothing of the busy block or the booking: not its start, its end or its title.
    for (const bit of [String(ist(19, 9, 47)), String(ist(19, 12, 13)), "Secret Thursday", String(ist(20, 11))]) {
      expect(JSON.stringify(body)).not.toContain(bit);
    }
  });

  it("answers the same fullDays whatever makes the day full", async () => {
    const answers: unknown[] = [];
    const host = app.person("Same Host");
    app.signIn(host.id);
    const capped = await app.newLink({ aheadDays: 6, maxPerDay: 2 });
    const plain = await app.newLink({ aheadDays: 6 });
    app.signOut();
    // The plain link while Thursday is free: no full day.
    expect((await page(plain)).fullDays).toEqual([]);
    // Capped by two bookings on Thursday.
    await app.bookAs(capped, ist(19, 10, 30));
    await app.bookAs(capped, ist(19, 11, 30));
    answers.push((await page(capped)).fullDays);
    // The plain link sees those two bookings as busy, plus a busy 10:07-11:22 and 11:01-11:29.
    db.setBusy(host.id, host.calendarId, [
      { start: ist(19, 10, 7), end: ist(19, 10, 22), eventId: "a" },
      { start: ist(19, 11, 1), end: ist(19, 11, 29), eventId: "b" },
    ]);
    answers.push((await page(plain)).fullDays);
    expect(answers).toEqual([[ist(19, 10)], [ist(19, 10)]]);
  });

  it("lists no days at all while nothing is free: busy every day, or a host who hasn't allowed access", async () => {
    const days = [18, 19, 20, 23].map((d) => ({ start: ist(d, 10), end: ist(d, 12) }));
    const { id } = await app.hostWithLink({ aheadDays: 6 }, { busy: days });
    expect(await page(id)).toMatchObject({ slots: [], fullDays: [] });
    // The same link with one free time left: the other days are full again.
    const { id: oneFree } = await app.hostWithLink({ aheadDays: 6 }, { busy: days.slice(1) });
    expect((await page(oneFree)).fullDays).toEqual([ist(19, 10), ist(20, 10), ist(23, 10)]);
    // No access: no times and no days, though Thursday is busy.
    const { id: noAccess } = await app.hostWithLink({ aheadDays: 6 }, { busy: days.slice(1), bookingAccess: false });
    expect(await page(noAccess)).toMatchObject({ slots: [], fullDays: [] });
  });

  it("lists no days for a link that took 30 bookings in the last hour", async () => {
    const wide = { durationMin: 15, startMin: 0, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], aheadDays: 3 };
    const { id } = await app.hostWithLink(wide);
    const times = await app.startsOf(id);
    for (const t of times.slice(40, 70)) await app.bookAs(id, t);
    expect(await page(id)).toMatchObject({ slots: [], fullDays: [] });
  });
});

describe("the page's list (TimeList)", () => {
  const clock = { zone: IST, hour12: false };
  const props = (slots: Span[], fullDays: number[]) => ({
    slots,
    fullDays,
    clock,
    at: slots[0]?.start ?? NOW,
    problem: null,
    focus: false,
    onPick: () => {},
  });

  it("shows a full day in its place as 'Fully booked', with no time buttons", () => {
    const i = input({ busy: [busyDay(19)] });
    const { slots, full } = offeredTimes(i);
    const { root } = render(TimeList, props(slots, full));
    const headings = byTag(root, "h3");
    expect(headings.map(textOf)).toEqual(["Wednesday 18 November", "Thursday 19 November", "Friday 20 November", "Monday 23 November"]);
    // Each day's block: its heading, then its times or "Fully booked".
    const blocks = headings.map((h) => all(root, (e) => e.children.includes(h))[0]);
    const buttons = blocks.map((b) => byTag(b, "button").map(textOf));
    expect(buttons).toEqual([["10:00", "10:30", "11:00", "11:30"], [], ["10:00", "10:30", "11:00", "11:30"], ["10:00", "10:30", "11:00", "11:30"]]);
    expect(blocks.map((b) => textOf(b).endsWith("Fully booked"))).toEqual([false, true, false, false]);
    expect(textOf(blocks[1])).toBe("Thursday 19 November Fully booked");
    expect(byTag(root, "button")).toHaveLength(12);
  });

  it("keeps 'No free times right now. Try again later.' when nothing is free, listing no day", () => {
    const { root, text } = render(TimeList, props([], [ist(19, 10), ist(20, 10)]));
    expect(text).toContain("No free times right now. Try again later.");
    expect(text).not.toContain("Fully booked");
    expect(byTag(root, "h3")).toEqual([]);
    expect(byTag(root, "button")).toEqual([]);
  });

  it("shows the visitor's days: a visitor in Los Angeles sees Monday's full day on Sunday", () => {
    const i = input({ busy: [busyDay(23)] });
    const { slots, full } = offeredTimes(i);
    const { root } = render(TimeList, { ...props(slots, full), clock: { zone: LA, hour12: true } });
    expect(byTag(root, "h3").map(textOf)).toEqual(["Tuesday 17 November", "Wednesday 18 November", "Thursday 19 November", "Friday 20 November", "Sunday 22 November"]);
    const sunday = all(root, (e) => e.children.some((c) => typeof c !== "string" && c.tag === "h3" && textOf(c) === "Sunday 22 November"))[0];
    expect(textOf(sunday)).toBe("Sunday 22 November Fully booked");
  });
});
