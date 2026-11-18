// Weekly search in Find a time: a weekday and time that suits the team every
// week for the next weeks. Written from the acceptance criteria of the
// feature, not from the implementation.

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  findQuorumSlots,
  findWeeklySlots,
  parseWeeks,
  weeklyDays,
  type DayFilter,
  type WindowsFor,
} from "@/lib/availability";
import type { Interval } from "@/lib/intervals";
import { buildIcs, googleCalendarUrl, outlookUrl, type InviteDraft } from "@/lib/invite";
import { dayStart, MINUTE, zonedTime } from "@/lib/time";
import type { BusyBlock, PersonAvailability } from "@/lib/types";

const HOUR_MS = 60 * MINUTE;
const DAY_MS = 24 * HOUR_MS;

// Calendar-day arithmetic of this file's own, so the expected days do not lean
// on the helpers under test.
const utcMidnight = (day: string) => Date.parse(`${day}T00:00:00Z`);
const plusDays = (day: string, n: number) => new Date(utcMidnight(day) + n * DAY_MS).toISOString().slice(0, 10);
const dayOfWeek = (day: string) => new Date(utcMidnight(day)).getUTCDay();

function allows(filter: DayFilter, wd: number): boolean {
  const weekend = wd === 0 || wd === 6;
  return filter === "all" || (filter === "weekends" ? weekend : !weekend);
}

/** Criterion 1 read directly. */
function occurrences(from: string, weeks: number, filter: DayFilter): string[][] {
  const lists: string[][] = [];
  for (let i = 0; i < 7; i++) {
    const first = plusDays(from, i);
    if (allows(filter, dayOfWeek(first))) lists.push(Array.from({ length: weeks }, (_, k) => plusDays(first, 7 * k)));
  }
  return lists;
}

function person(name: string, busy: BusyBlock[] = []): PersonAvailability {
  const id = name.toLowerCase().replace(/\s+/g, "-");
  return {
    id,
    name,
    team: null,
    color: "#2f7de1",
    timezone: "Europe/Istanbul",
    email: `${id}@example.com`,
    calendars: ["Job"],
    data: "ok",
    pending: false,
    stale: false,
    busy,
  };
}

const block = (start: number, end: number, extra: Partial<BusyBlock> = {}): BusyBlock => ({
  start,
  end,
  calendar: 0,
  label: "Job",
  ...extra,
});

const allDayOn = (day: string, tz: string): BusyBlock =>
  block(dayStart(day, tz), dayStart(plusDays(day, 1), tz), { allDay: true });

type Weekly = ReturnType<typeof findWeeklySlots>;
type NamedSlot = { slot: Interval; free: string[]; missing: string[] };
type NamedWeek = { weekday: number; days: string[]; slots: NamedSlot[] };

/** The result with people as names, for readable comparisons. */
function named(result: Weekly): NamedWeek[] {
  return result.map((w) => ({
    weekday: w.weekday,
    days: w.days,
    slots: w.slots.map((s) => ({ slot: s.slot, free: s.free.map((p) => p.name), missing: s.missing.map((p) => p.name) })),
  }));
}

/** The criteria do not order the slots of a weekday beyond one week, so compare them by range. */
const byRange = (a: NamedSlot, b: NamedSlot) => a.slot[0] - b.slot[0] || a.slot[1] - b.slot[1];
const rangeOrder = (weeks: NamedWeek[]): NamedWeek[] => weeks.map((w) => ({ ...w, slots: [...w.slots].sort(byRange) }));

// ---------------------------------------------------------------------------

describe("weeklyDays (criterion 1)", () => {
  it("gives the worked example", () => {
    expect(weeklyDays("2026-11-18", 2, "weekends")).toEqual([
      ["2026-11-21", "2026-11-28"],
      ["2026-11-22", "2026-11-29"],
    ]);
  });

  it("starts each weekday on or after from and orders the lists by their first day", () => {
    // 2026-11-18 is a Wednesday.
    expect(weeklyDays("2026-11-18", 3, "all")).toEqual([
      ["2026-11-18", "2026-11-25", "2026-12-02"],
      ["2026-11-19", "2026-11-26", "2026-12-03"],
      ["2026-11-20", "2026-11-27", "2026-12-04"],
      ["2026-11-21", "2026-11-28", "2026-12-05"],
      ["2026-11-22", "2026-11-29", "2026-12-06"],
      ["2026-11-23", "2026-11-30", "2026-12-07"],
      ["2026-11-24", "2026-12-01", "2026-12-08"],
    ]);
    expect(weeklyDays("2026-11-18", 2, "weekdays")).toEqual([
      ["2026-11-18", "2026-11-25"],
      ["2026-11-19", "2026-11-26"],
      ["2026-11-20", "2026-11-27"],
      ["2026-11-23", "2026-11-30"],
      ["2026-11-24", "2026-12-01"],
    ]);
  });

  it("counts from itself when its weekday is allowed", () => {
    // 2026-11-21 is a Saturday, 2026-11-22 a Sunday.
    expect(weeklyDays("2026-11-21", 1, "weekends")).toEqual([["2026-11-21"], ["2026-11-22"]]);
    expect(weeklyDays("2026-11-22", 1, "weekends")).toEqual([["2026-11-22"], ["2026-11-28"]]);
    expect(weeklyDays("2026-11-22", 1, "weekdays")).toEqual([
      ["2026-11-23"],
      ["2026-11-24"],
      ["2026-11-25"],
      ["2026-11-26"],
      ["2026-11-27"],
    ]);
  });

  it("steps over months, years and clock changes by calendar days", () => {
    // 2026-12-29 is a Tuesday; summer time ends in Europe on Sunday 2026-10-25
    // and in the US on Sunday 2026-11-01.
    expect(weeklyDays("2026-12-29", 2, "weekends")).toEqual([
      ["2027-01-02", "2027-01-09"],
      ["2027-01-03", "2027-01-10"],
    ]);
    expect(weeklyDays("2026-10-18", 3, "weekends")).toEqual([
      ["2026-10-18", "2026-10-25", "2026-11-01"],
      ["2026-10-24", "2026-10-31", "2026-11-07"],
    ]);
  });

  it("matches a direct reading for every start day of two years, 1 to 8 weeks", () => {
    for (let i = 0; i < 731; i++) {
      const from = plusDays("2026-01-01", i);
      for (const filter of ["all", "weekdays", "weekends"] as const) {
        for (const weeks of [1, 2, 4, 6, 8]) {
          expect(weeklyDays(from, weeks, filter), `${from} ${filter} ${weeks}`).toEqual(occurrences(from, weeks, filter));
        }
      }
    }
  });
});

// Hand-made cases in a zone without clock changes. 2026-10-07 and 2026-10-14
// are Wednesdays; only they have search hours, so only Wednesday can have a
// slot.
const IST = "Europe/Istanbul";
const W1 = "2026-10-07";
const W2 = "2026-10-14";
const at = (day: string, h: number) => zonedTime(day, h, IST);
const busyOn = (day: string, ...pairs: [number, number][]) => pairs.map(([s, e]) => block(at(day, s), at(day, e)));

/** Search hours per Wednesday, as [from, to] hours; none on other days. */
function wednesdayHours(w1: [number, number][], w2: [number, number][] = w1): WindowsFor {
  return (day) => {
    const list = day === W1 ? w1 : day === W2 ? w2 : [];
    return list.map(([s, e]): Interval => [at(day, s), at(day, e)]);
  };
}

const twoWednesdays = (people: PersonAvailability[], windows: WindowsFor, minMinutes: number, need: number) =>
  rangeOrder(named(findWeeklySlots(people, W1, 2, "all", windows, minMinutes * MINUTE, need, IST)));

const row = (from: number, to: number, free: string[], missing: string[] = []): NamedSlot => ({
  slot: [at(W1, from), at(W1, to)],
  free,
  missing,
});

const wednesday = (...slots: NamedSlot[]): NamedWeek[] => [{ weekday: 3, days: [W1, W2], slots }];

describe("findWeeklySlots: shape (criterion 2)", () => {
  it("has the parameters and result of the criteria", () => {
    // Checked by `npm run typecheck`: tsc compiles this file.
    expectTypeOf(findWeeklySlots).toBeCallableWith(
      [person("A")],
      "2026-11-18",
      4,
      "weekdays",
      wednesdayHours([[9, 17]]),
      60 * MINUTE,
      2,
      IST,
    );
    expectTypeOf(findWeeklySlots).returns.toEqualTypeOf<
      {
        weekday: number;
        days: string[];
        slots: { slot: [number, number]; free: PersonAvailability[]; missing: PersonAvailability[] }[];
      }[]
    >();
    expectTypeOf(weeklyDays).toBeCallableWith("2026-11-18", 2, "weekends");
    expectTypeOf(weeklyDays).returns.toEqualTypeOf<string[][]>();
    expectTypeOf(parseWeeks).returns.toEqualTypeOf<number | null>();
    expectTypeOf<InviteDraft["weekly"]>().toEqualTypeOf<{ count: number; timezone: string } | undefined>();
  });

  it("gives one entry per weekday with a slot, in weeklyDays' order, with its days and weekday", () => {
    // From Wednesday 2026-11-18: no search hours on Fridays and Saturdays, and
    // A is busy all of both Mondays.
    const windows: WindowsFor = (day) => ([5, 6].includes(dayOfWeek(day)) ? [] : [[at(day, 9), at(day, 17)]]);
    const A = person("A", [allDayOn("2026-11-23", IST), allDayOn("2026-11-30", IST)]);
    const res = findWeeklySlots([A], "2026-11-18", 2, "all", windows, 60 * MINUTE, 1, IST);
    expect(res.map((w) => [w.weekday, w.days])).toEqual([
      [3, ["2026-11-18", "2026-11-25"]],
      [4, ["2026-11-19", "2026-11-26"]],
      [0, ["2026-11-22", "2026-11-29"]],
      [2, ["2026-11-24", "2026-12-01"]],
    ]);
    for (const w of res) {
      expect(w.slots, w.days[0]).toEqual([{ slot: [at(w.days[0], 9), at(w.days[0], 17)], free: [A], missing: [] }]);
    }
  });

  it("gives nothing when no weekday has a slot", () => {
    const A = person("A", [allDayOn(W1, IST), allDayOn(W2, IST)]);
    expect(findWeeklySlots([A], W1, 2, "all", wednesdayHours([[9, 17]]), 60 * MINUTE, 1, IST)).toEqual([]);
  });
});

describe("findWeeklySlots: which ranges are listed (criterion 3)", () => {
  it("(a) keeps a range inside the search hours of every week", () => {
    const res = twoWednesdays([person("A")], wednesdayHours([[9, 17]], [[8, 12], [13, 18]]), 60, 1);
    expect(res).toEqual(wednesday(row(9, 12, ["A"]), row(13, 17, ["A"])));
  });

  it("(b) needs the length on the common free time", () => {
    // Free 10:15–11:00 in both weeks: 45 minutes.
    const A = person("A", [...busyOn(W1, [9, 10], [11, 13]), ...busyOn(W2, [9, 10.25], [12, 13])]);
    const hours = wednesdayHours([[9, 13]]);
    expect(twoWednesdays([A], hours, 60, 1)).toEqual([]);
    expect(twoWednesdays([A], hours, 46, 1)).toEqual([]);
    expect(twoWednesdays([A], hours, 45, 1)).toEqual(wednesday(row(10.25, 11, ["A"])));
  });

  it("(c) counts all-day and tentative blocks as busy, in any week", () => {
    const people = [
      person("A"),
      person("B", busyOn(W2, [12, 13]).map((b) => ({ ...b, tentative: true }))),
      person("C", [allDayOn(W2, IST)]),
    ];
    expect(twoWednesdays(people, wednesdayHours([[9, 17]]), 60, 1)).toEqual(
      wednesday(row(9, 12, ["A", "B"], ["C"]), row(9, 17, ["A"], ["B", "C"]), row(13, 17, ["A", "B"], ["C"])),
    );
  });

  it("(c) counts a block from the evening before that runs into the morning", () => {
    const A = person("A", [block(at("2026-10-13", 22), at(W2, 10))]);
    expect(twoWednesdays([A], wednesdayHours([[9, 17]]), 60, 1)).toEqual(wednesday(row(10, 17, ["A"])));
  });

  it("(d) ends a range where one of its people is busy in some week", () => {
    // A is free 9–12 in the first week and 10–17 in the second; B always.
    const A = person("A", [...busyOn(W1, [12, 17]), ...busyOn(W2, [9, 10])]);
    expect(twoWednesdays([A, person("B")], wednesdayHours([[9, 17]]), 60, 1)).toEqual(
      wednesday(row(9, 17, ["B"], ["A"]), row(10, 12, ["A", "B"])),
    );
  });

  it("lists every end for one start, longest with the fewest people", () => {
    const people = [
      person("A", [...busyOn(W1, [9, 10], [16, 17]), ...busyOn(W2, [9, 10], [15, 17])]),
      person("B", [...busyOn(W1, [9, 10], [14, 17]), ...busyOn(W2, [9, 10], [14, 17])]),
      person("C", [...busyOn(W1, [9, 10], [12, 17]), ...busyOn(W2, [9, 10], [12, 17])]),
    ];
    const ladder = [row(10, 12, ["A", "B", "C"]), row(10, 14, ["A", "B"], ["C"]), row(10, 15, ["A"], ["B", "C"])];
    const hours = wednesdayHours([[9, 17]]);
    expect(twoWednesdays(people, hours, 60, 1)).toEqual(wednesday(...ladder));
    expect(twoWednesdays(people, hours, 60, 2)).toEqual(wednesday(...ladder.slice(0, 2)));
    expect(twoWednesdays(people, hours, 60, 3)).toEqual(wednesday(...ladder.slice(0, 1)));
  });

  it("does not list a range its people could extend", () => {
    // A and B are free 10–13 both weeks; C 11–12 in the first and 10:30–12:30
    // in the second, so 11–12 every week.
    const people = [
      person("A", [...busyOn(W1, [9, 10], [13, 17]), ...busyOn(W2, [9, 10], [13, 17])]),
      person("B", [...busyOn(W1, [9, 10], [13, 17]), ...busyOn(W2, [9, 10], [13, 17])]),
      person("C", [...busyOn(W1, [9, 11], [12, 17]), ...busyOn(W2, [9, 10.5], [12.5, 17])]),
    ];
    expect(twoWednesdays(people, wednesdayHours([[9, 17]]), 60, 2)).toEqual(
      wednesday(row(10, 13, ["A", "B"], ["C"]), row(11, 12, ["A", "B", "C"])),
    );
  });

  it("treats touching search hours as one, as findQuorumSlots does", () => {
    const A = person("A", [...busyOn(W1, [9.5, 11]), ...busyOn(W2, [9.5, 11])]);
    const hours = wednesdayHours(
      [
        [9, 12],
        [12, 17],
      ],
      [[9, 17]],
    );
    expect(twoWednesdays([A, person("B")], hours, 60, 2)).toEqual(wednesday(row(11, 17, ["A", "B"])));
  });

  it("matches a brute-force reading of criteria 1 to 4 on random calendars across clock changes", () => {
    const seen = {
      slots: 0,
      missing: 0,
      sharedStart: 0,
      overlapping: 0,
      acrossChange: 0,
      hoursDiffer: 0,
      differentGroups: 0,
      needAll: 0,
    };
    for (let seed = 1; seed <= 400; seed++) {
      const c = randomCase(seed, "apart", 2, 4);
      const want = bruteForce(c, seen);
      const got = findWeeklySlots(c.people, c.from, c.weeks, c.filter, c.windowsFor, c.minMs, c.need, c.tz);
      expect(rangeOrder(named(got)), `seed ${seed}`).toEqual(want);
      if (c.need === c.people.length) seen.needAll++;
      for (const w of want) {
        seen.slots += w.slots.length;
        if (crossesChange(w.days, c.tz)) seen.acrossChange += w.slots.length;
        const first = JSON.stringify(c.windowsFor(w.days[0]).map(([s, e]) => [wallHours(s, w.days[0], c), wallHours(e, w.days[0], c)]));
        if (w.days.some((d) => JSON.stringify(c.windowsFor(d).map(([s, e]) => [wallHours(s, d, c), wallHours(e, d, c)])) !== first)) {
          seen.hoursDiffer += w.slots.length;
        }
        w.slots.forEach((s, i) => {
          if (s.missing.length) seen.missing++;
          if (w.slots.some((o, j) => j !== i && o.slot[0] === s.slot[0])) seen.sharedStart++;
          if (w.slots.some((o, j) => j !== i && o.slot[0] < s.slot[1] && o.slot[1] > s.slot[0])) seen.overlapping++;
        });
      }
    }
    // The random calendars must reach the cases the criteria are about (seeds
    // 1–400 give 2618 slots: 1806 with someone missing, 1083 sharing a start,
    // 1729 overlapping another, 364 in a series across a clock change, 1470
    // where the search hours differ between weeks; 272 weekday lists where
    // enough people are free each week but not the same ones; 188 rounds ask
    // for everyone).
    expect(seen.slots).toBeGreaterThan(1300);
    expect(seen.missing).toBeGreaterThan(900);
    expect(seen.sharedStart).toBeGreaterThan(500);
    expect(seen.overlapping).toBeGreaterThan(850);
    expect(seen.acrossChange).toBeGreaterThan(180);
    expect(seen.hoursDiffer).toBeGreaterThan(700);
    expect(seen.differentGroups).toBeGreaterThan(130);
    expect(seen.needAll).toBeGreaterThan(90);
  });

  it("joins touching and overlapping search hours on every day, on random calendars", () => {
    let joined = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const c = randomCase(seed, "any", 2, 3);
      const want = bruteForce(c);
      const got = findWeeklySlots(c.people, c.from, c.weeks, c.filter, c.windowsFor, c.minMs, c.need, c.tz);
      expect(rangeOrder(named(got)), `seed ${seed}`).toEqual(want);
      for (const w of want) {
        for (const { slot } of w.slots) {
          const [s, e] = slot;
          if (!c.windowsFor(w.days[0]).some(([w0, w1]) => w0 <= s && e <= w1)) joined++;
        }
      }
    }
    // Seeds 1–300 give 232 slots across two joined search windows.
    expect(joined).toBeGreaterThan(110);
  });
});

describe("findWeeklySlots: free and missing (criterion 4)", () => {
  it("names who is free every week and who is not, in the input order", () => {
    const people = [
      person("D"),
      person("A", [allDayOn(W2, IST)]),
      person("C", busyOn(W1, [8, 9])),
      person("B", busyOn(W1, [12, 13])),
    ];
    const res = findWeeklySlots(people, W1, 2, "all", wednesdayHours([[9, 17]]), 60 * MINUTE, 2, IST);
    const [D, A, C, B] = people;
    expect(rangeOrder(named(res))).toEqual(
      wednesday(row(9, 12, ["D", "C", "B"], ["A"]), row(9, 17, ["D", "C"], ["A", "B"]), row(13, 17, ["D", "C", "B"], ["A"])),
    );
    // The very people passed in, every one of them in each slot.
    for (const s of res[0].slots) {
      expect([...s.free, ...s.missing].sort((x, y) => people.indexOf(x) - people.indexOf(y))).toStrictEqual(people);
      for (const p of [...s.free, ...s.missing]) expect([D, A, C, B]).toContain(p);
    }
  });

  it("leaves missing empty with need at or above everyone", () => {
    const people = [person("A", [...busyOn(W1, [12, 13]), ...busyOn(W2, [12, 13])]), person("B")];
    const hours = wednesdayHours([[9, 17]]);
    expect(twoWednesdays(people, hours, 60, 2)).toEqual(wednesday(row(9, 12, ["A", "B"]), row(13, 17, ["A", "B"])));
    for (const need of [3, 5]) {
      const res = findWeeklySlots(people, W1, 2, "all", hours, 60 * MINUTE, need, IST);
      for (const s of res.flatMap((w) => w.slots)) {
        expect(s.missing, `need ${need}`).toEqual([]);
        expect(s.free, `need ${need}`).toEqual(people);
      }
    }
    for (let seed = 1; seed <= 150; seed++) {
      const c = randomCase(seed, "apart", 2, 4);
      for (const need of [c.people.length, c.people.length + 1, c.people.length + 4]) {
        const res = findWeeklySlots(c.people, c.from, c.weeks, c.filter, c.windowsFor, c.minMs, need, c.tz);
        const notEveryone = res.flatMap((w) => w.slots).filter((s) => s.missing.length > 0 || s.free.length !== c.people.length);
        expect(notEveryone, `seed ${seed}, need ${need}`).toEqual([]);
      }
    }
  });
});

describe("findWeeklySlots: one week is findQuorumSlots (criterion 5)", () => {
  const oneWeek = (c: Case) =>
    occurrences(c.from, 1, c.filter).flatMap(([day]) => {
      const q = findQuorumSlots(c.people, [day], c.windowsFor, c.minMs, 0, c.need);
      return q.length ? [{ weekday: dayOfWeek(day), days: [day], slots: q[0].slots }] : [];
    });

  it("gives findQuorumSlots' slots, free and missing for each day, in order", () => {
    // Touching, overlapping and unordered search hours included; need up to
    // two above everyone.
    let slots = 0;
    let joined = 0;
    let needAbove = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const c = randomCase(seed, "any", 1, 1, 2);
      const want = oneWeek(c);
      expect(findWeeklySlots(c.people, c.from, 1, c.filter, c.windowsFor, c.minMs, c.need, c.tz), `seed ${seed}`).toEqual(want);
      if (c.need > c.people.length) needAbove++;
      for (const w of want) {
        slots += w.slots.length;
        const windows = c.windowsFor(w.days[0]);
        joined += w.slots.filter(({ slot: [s, e] }) => !windows.some(([w0, w1]) => w0 <= s && e <= w1)).length;
      }
    }
    // Seeds 1–500 give 4603 slots, 652 across two joined search windows; 208
    // rounds ask for more people than there are.
    expect(slots).toBeGreaterThan(2300);
    expect(joined).toBeGreaterThan(320);
    expect(needAbove).toBeGreaterThan(100);
  });

  it("joins touching search hours as findQuorumSlots does", () => {
    const touching: WindowsFor = (day) => [
      [at(day, 9), at(day, 12)],
      [at(day, 12), at(day, 17)],
    ];
    const people = [person("A", busyOn(W1, [9.5, 11])), person("B")];
    for (const need of [1, 2, 3]) {
      const c: Case = { people, from: W1, weeks: 1, filter: "all", windowsFor: touching, minMs: 60 * MINUTE, need, tz: IST };
      const res = findWeeklySlots(people, W1, 1, "all", touching, 60 * MINUTE, need, IST);
      expect(res, `need ${need}`).toEqual(oneWeek(c));
      expect(res[0].slots.map((s) => s.slot)).toContainEqual([at(W1, 11), at(W1, 17)]);
    }
  });

  it("finds nothing without people, as findQuorumSlots does", () => {
    for (const need of [0, 1, 2]) {
      expect(findQuorumSlots([], [W1], wednesdayHours([[9, 17]]), 60 * MINUTE, 0, need)).toEqual([]);
      expect(findWeeklySlots([], W1, 1, "all", wednesdayHours([[9, 17]]), 60 * MINUTE, need, IST)).toEqual([]);
    }
  });
});

describe("findWeeklySlots: the same people every week (criterion 6)", () => {
  // Everyone is busy outside 10:00–12:00 in both weeks.
  const outside = (day: string) => busyOn(day, [9, 10], [12, 17]);
  const hours = wednesdayHours([[9, 17]]);

  it("finds nothing when two are free each week but not the same two", () => {
    const A = person("A", [...outside(W1), allDayOn(W2, IST)]);
    const B = person("B", [...outside(W1), ...outside(W2)]);
    const C = person("C", [allDayOn(W1, IST), ...outside(W2)]);
    expect(findWeeklySlots([A, B, C], W1, 2, "all", hours, 60 * MINUTE, 2, IST)).toEqual([]);
  });

  it("finds 10:00–12:00 with B and C once C is free in the first week too", () => {
    const A = person("A", [...outside(W1), allDayOn(W2, IST)]);
    const B = person("B", [...outside(W1), ...outside(W2)]);
    const C = person("C", [...outside(W1), ...outside(W2)]);
    expect(findWeeklySlots([A, B, C], W1, 2, "all", hours, 60 * MINUTE, 2, IST)).toEqual([
      { weekday: 3, days: [W1, W2], slots: [{ slot: [at(W1, 10), at(W1, 12)], free: [B, C], missing: [A] }] },
    ]);
  });
});

describe("findWeeklySlots: daylight saving (criterion 7)", () => {
  // Berlin is UTC+2 until summer time ends at 03:00 on Sunday 2026-10-25, then
  // UTC+1. Times here are written in UTC by hand, not through the app's helpers.
  const TZ = "Europe/Berlin";
  const utc = (iso: string) => Date.parse(iso);
  const berlin = (day: string, h: number) => utcMidnight(day) + (h - (day < "2026-10-25" ? 2 : 1)) * HOUR_MS;
  const nineToFive: WindowsFor = (day) => [[berlin(day, 9), berlin(day, 17)]];
  const wednesdays = ["2026-10-14", "2026-10-21", "2026-10-28"];

  it("keeps the wall-clock time across the change", () => {
    expect(berlin("2026-10-28", 12)).toBe(utc("2026-10-28T11:00:00Z"));
    const P = person("P", wednesdays.map((d) => block(berlin(d, 12), berlin(d, 13))));
    const res = findWeeklySlots([P], "2026-10-14", 3, "all", nineToFive, 60 * MINUTE, 1, TZ);
    expect(res.find((w) => w.weekday === 3)).toEqual({
      weekday: 3,
      days: wednesdays,
      slots: [
        // 09:00–12:00 and 13:00–17:00 Berlin time on 14 October.
        { slot: [utc("2026-10-14T07:00:00Z"), utc("2026-10-14T10:00:00Z")], free: [P], missing: [] },
        { slot: [utc("2026-10-14T11:00:00Z"), utc("2026-10-14T15:00:00Z")], free: [P], missing: [] },
      ],
    });
    // P is free on the other days, so every other weekday is 09:00–17:00 on
    // its first day, including Sunday, whose 25 October is the change itself.
    const others = res.filter((w) => w.weekday !== 3);
    expect(others.map((w) => w.days[0])).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"]);
    expect(res.find((w) => w.weekday === 0)?.days).toEqual(["2026-10-18", "2026-10-25", "2026-11-01"]);
    for (const w of others) {
      expect(w.slots, w.days[0]).toEqual([{ slot: [berlin(w.days[0], 9), berlin(w.days[0], 17)], free: [P], missing: [] }]);
    }
  });

  it("reads a block fixed in UTC at its Berlin time in each week", () => {
    // 11:00–12:00Z is 13:00–14:00 Berlin time before the change and 12:00–13:00 after.
    const P = person("P", wednesdays.map((d) => block(utc(`${d}T11:00:00Z`), utc(`${d}T12:00:00Z`))));
    const res = findWeeklySlots([P], "2026-10-14", 3, "weekdays", nineToFive, 60 * MINUTE, 1, TZ);
    expect(res.find((w) => w.weekday === 3)?.slots).toEqual([
      { slot: [utc("2026-10-14T07:00:00Z"), utc("2026-10-14T10:00:00Z")], free: [P], missing: [] },
      { slot: [utc("2026-10-14T12:00:00Z"), utc("2026-10-14T15:00:00Z")], free: [P], missing: [] },
    ]);
  });

  it("keeps the wall-clock time when summer time starts", () => {
    // Summer time starts in Berlin on 2026-03-29: 12:00 is 11:00Z on 25 March
    // and 10:00Z on 1 April.
    const P = person("P", [
      block(utc("2026-03-25T11:00:00Z"), utc("2026-03-25T12:00:00Z")),
      block(utc("2026-04-01T10:00:00Z"), utc("2026-04-01T11:00:00Z")),
    ]);
    const spring: WindowsFor = (day) => {
      const off = day < "2026-03-29" ? 1 : 2;
      return [[utcMidnight(day) + (9 - off) * HOUR_MS, utcMidnight(day) + (17 - off) * HOUR_MS]];
    };
    const res = findWeeklySlots([P], "2026-03-25", 2, "weekdays", spring, 60 * MINUTE, 1, TZ);
    expect(res.find((w) => w.weekday === 3)).toEqual({
      weekday: 3,
      days: ["2026-03-25", "2026-04-01"],
      slots: [
        { slot: [utc("2026-03-25T08:00:00Z"), utc("2026-03-25T11:00:00Z")], free: [P], missing: [] },
        { slot: [utc("2026-03-25T12:00:00Z"), utc("2026-03-25T16:00:00Z")], free: [P], missing: [] },
      ],
    });
  });
});

describe("findWeeklySlots: speed (criterion 8)", () => {
  it("handles 15 people with 8 blocks a day, 8 weeks, all seven weekdays, need 8, in under a second", () => {
    const tz = IST;
    const from = "2026-11-16"; // a Monday
    const days = Array.from({ length: 56 }, (_, i) => plusDays(from, i));
    const r = random(2026);
    const q = (day: string, quarters: number) => zonedTime(day, quarters / 4, tz);
    const people = Array.from({ length: 15 }, (_, i) => {
      // Five standing meetings on each weekday and three one-off blocks a day,
      // all between 08:00 and 20:00.
      const standing = Array.from({ length: 7 }, () =>
        Array.from({ length: 5 }, () => {
          const s = r.int(32, 76);
          return [s, s + r.int(1, 4)] as const;
        }),
      );
      return person(
        `Person ${i}`,
        days.flatMap((day) => [
          ...standing[dayOfWeek(day)].map(([s, e]) => block(q(day, s), q(day, e))),
          ...Array.from({ length: 3 }, () => {
            const s = r.int(32, 76);
            return block(q(day, s), q(day, s + r.int(1, 4)));
          }),
        ]),
      );
    });
    expect(people.every((p) => p.busy.length === 8 * 56)).toBe(true);
    const windows: WindowsFor = (day) => [[zonedTime(day, 8, tz), zonedTime(day, 22, tz)]];
    const started = performance.now();
    const res = findWeeklySlots(people, from, 8, "all", windows, 30 * MINUTE, 8, tz);
    const took = performance.now() - started;
    expect(took).toBeLessThan(1000);
    // The search had work to do: every weekday has a slot, some without everyone.
    expect(res.map((w) => w.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(res.flatMap((w) => w.slots).filter((s) => s.missing.length > 0).length).toBeGreaterThan(0);
  });
});

describe("parseWeeks (criterion 9)", () => {
  it("reads 4, 6 and 8", () => {
    expect(parseWeeks("4")).toBe(4);
    expect(parseWeeks("6")).toBe(6);
    expect(parseWeeks("8")).toBe(8);
  });

  it("returns null for anything else", () => {
    const cases = [
      undefined,
      null,
      "",
      "0",
      "1",
      "2",
      "3",
      "5",
      "7",
      "9",
      "12",
      "16",
      "abc",
      "04",
      " 4",
      "4 ",
      "+4",
      "-4",
      "4.0",
      "4e0",
      "0x4",
      "4x",
      "Infinity",
      "NaN",
    ];
    for (const raw of cases) expect(parseWeeks(raw), JSON.stringify(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Invites. The exact strings below were made by the code before this branch
// (feature/quorum at d0444da).

const goldenDraft: InviteDraft = {
  title: "Team sync; plans, budget",
  start: Date.parse("2026-10-07T15:00:00Z"),
  end: Date.parse("2026-10-07T16:00:00Z"),
  note: "Agenda:\n1. Launch",
  location: "Zoom",
  attendees: [
    { name: "Ahmet Yılmaz", email: "ahmet@example.com" },
    { name: "Elif, Kaya", email: "elif@example.com" },
  ],
};
const plainDraft: InviteDraft = {
  title: "Yönetim kurulu",
  start: Date.parse("2026-10-21T07:30:00Z"),
  end: Date.parse("2026-10-21T09:00:00Z"),
  note: "",
  location: "",
  attendees: [],
};
const NOW = Date.parse("2026-10-07T10:00:00Z");

const BEFORE = {
  google:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Team+sync%3B+plans%2C+budget&dates=20261007T150000Z%2F20261007T160000Z&details=Agenda%3A%0A1.+Launch&location=Zoom&add=ahmet%40example.com%2Celif%40example.com",
  googleAuth:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Team+sync%3B+plans%2C+budget&dates=20261007T150000Z%2F20261007T160000Z&details=Agenda%3A%0A1.+Launch&location=Zoom&add=ahmet%40example.com%2Celif%40example.com&authuser=omer%40example.com",
  googlePlain:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Y%C3%B6netim+kurulu&dates=20261021T073000Z%2F20261021T090000Z",
  googlePlainAuth:
    "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Y%C3%B6netim+kurulu&dates=20261021T073000Z%2F20261021T090000Z&authuser=omer%40example.com",
  outlookWork:
    "https://outlook.office.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent&subject=Team+sync%3B+plans%2C+budget&startdt=2026-10-07T15%3A00%3A00Z&enddt=2026-10-07T16%3A00%3A00Z&body=Agenda%3A%0A1.+Launch&location=Zoom",
  outlookPersonal:
    "https://outlook.live.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent&subject=Team+sync%3B+plans%2C+budget&startdt=2026-10-07T15%3A00%3A00Z&enddt=2026-10-07T16%3A00%3A00Z&body=Agenda%3A%0A1.+Launch&location=Zoom",
  outlookPlain:
    "https://outlook.office.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent&subject=Y%C3%B6netim+kurulu&startdt=2026-10-21T07%3A30%3A00Z&enddt=2026-10-21T09%3A00%3A00Z",
  ics: [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ekip Takvim//Invite//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:abc@ekip-takvim",
    "DTSTAMP:20261007T100000Z",
    "DTSTART:20261007T150000Z",
    "DTEND:20261007T160000Z",
    "SUMMARY:Team sync\\; plans\\, budget",
    "DESCRIPTION:Agenda:\\n1. Launch",
    "LOCATION:Zoom",
    "ATTENDEE;CN=Ahmet Yılmaz;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=T",
    " RUE:mailto:ahmet@example.com",
    'ATTENDEE;CN="Elif, Kaya";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TR',
    " UE:mailto:elif@example.com",
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n"),
  icsPlain: [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ekip Takvim//Invite//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:xyz@ekip-takvim",
    "DTSTAMP:20261007T100000Z",
    "DTSTART:20261021T073000Z",
    "DTEND:20261021T090000Z",
    "SUMMARY:Yönetim kurulu",
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n"),
};

describe("googleCalendarUrl with weekly (criterion 10)", () => {
  const params = (url: string) => new URL(url).searchParams;

  it("repeats every week, count times, at the wall-clock time of the zone", () => {
    // Berlin is UTC+2 on 2026-10-21: 13:00Z is 15:00 there.
    const draft: InviteDraft = {
      ...goldenDraft,
      start: Date.parse("2026-10-21T13:00:00Z"),
      end: Date.parse("2026-10-21T14:30:00Z"),
      weekly: { count: 6, timezone: "Europe/Berlin" },
    };
    const p = params(googleCalendarUrl(draft));
    expect(p.get("recur")).toBe("RRULE:FREQ=WEEKLY;COUNT=6");
    expect(p.get("ctz")).toBe("Europe/Berlin");
    expect(p.get("dates")).toBe("20261021T150000/20261021T163000");
  });

  it("writes the start and end in the zone's own date and time", () => {
    const cases = [
      // Auckland is UTC+13: 19:30Z on 20 October is 08:30 on 21 October.
      ["2026-10-20T19:30:00Z", "2026-10-20T20:30:00Z", "Pacific/Auckland", 4, "20261021T083000/20261021T093000"],
      // New York is UTC-5 after 1 November; the meeting runs past midnight.
      ["2026-11-21T04:30:00Z", "2026-11-21T05:30:00Z", "America/New_York", 8, "20261120T233000/20261121T003000"],
      // Kolkata is UTC+5:30.
      ["2026-10-21T09:30:00Z", "2026-10-21T10:15:00Z", "Asia/Kolkata", 6, "20261021T150000/20261021T154500"],
      // Berlin in winter is UTC+1.
      ["2026-12-02T14:00:00Z", "2026-12-02T15:00:00Z", "Europe/Berlin", 4, "20261202T150000/20261202T160000"],
      ["2026-10-07T15:00:00Z", "2026-10-07T16:00:00Z", "UTC", 8, "20261007T150000/20261007T160000"],
    ] as const;
    for (const [start, end, timezone, count, dates] of cases) {
      const draft: InviteDraft = { ...plainDraft, start: Date.parse(start), end: Date.parse(end), weekly: { count, timezone } };
      for (const authuser of [undefined, "omer@example.com"]) {
        const p = params(googleCalendarUrl(draft, authuser));
        expect(p.get("dates"), timezone).toBe(dates);
        expect(p.get("ctz"), timezone).toBe(timezone);
        expect(p.get("recur"), timezone).toBe(`RRULE:FREQ=WEEKLY;COUNT=${count}`);
      }
    }
  });

  it("keeps the rest of the invite", () => {
    const rest = (url: string) => {
      const u = new URL(url);
      const entries = [...u.searchParams].filter(([k]) => !["dates", "recur", "ctz"].includes(k));
      return { at: u.origin + u.pathname, params: Object.fromEntries(entries), count: entries.length };
    };
    for (const draft of [goldenDraft, plainDraft]) {
      for (const authuser of [undefined, "omer@example.com"]) {
        const weekly = { ...draft, weekly: { count: 4, timezone: "Europe/Istanbul" } };
        expect(rest(googleCalendarUrl(weekly, authuser))).toEqual(rest(googleCalendarUrl(draft, authuser)));
      }
    }
  });

  it("is exactly what it was before this branch without weekly", () => {
    expect(googleCalendarUrl(goldenDraft)).toBe(BEFORE.google);
    expect(googleCalendarUrl(goldenDraft, "omer@example.com")).toBe(BEFORE.googleAuth);
    expect(googleCalendarUrl(plainDraft)).toBe(BEFORE.googlePlain);
    expect(googleCalendarUrl(plainDraft, "omer@example.com")).toBe(BEFORE.googlePlainAuth);
    expect(googleCalendarUrl({ ...goldenDraft, weekly: undefined })).toBe(BEFORE.google);
    expect(googleCalendarUrl({ ...plainDraft, weekly: undefined }, "omer@example.com")).toBe(BEFORE.googlePlainAuth);
  });
});

describe("outlookUrl and buildIcs with weekly (criterion 11)", () => {
  const weeklies = [
    { count: 4, timezone: "Europe/Berlin" },
    { count: 6, timezone: "America/New_York" },
    { count: 8, timezone: "Asia/Kolkata" },
  ];

  it("give the same output with or without weekly", () => {
    for (const draft of [goldenDraft, plainDraft]) {
      for (const weekly of weeklies) {
        const w = { ...draft, weekly };
        expect(outlookUrl(w, "work")).toBe(outlookUrl(draft, "work"));
        expect(outlookUrl(w, "personal")).toBe(outlookUrl(draft, "personal"));
        expect(buildIcs(w, "abc", NOW)).toBe(buildIcs(draft, "abc", NOW));
      }
    }
  });

  it("still make the one event they made before this branch", () => {
    for (const weekly of [undefined, ...weeklies]) {
      expect(outlookUrl({ ...goldenDraft, weekly }, "work")).toBe(BEFORE.outlookWork);
      expect(outlookUrl({ ...goldenDraft, weekly }, "personal")).toBe(BEFORE.outlookPersonal);
      expect(outlookUrl({ ...plainDraft, weekly }, "work")).toBe(BEFORE.outlookPlain);
      expect(buildIcs({ ...goldenDraft, weekly }, "abc", NOW)).toBe(BEFORE.ics);
      expect(buildIcs({ ...plainDraft, weekly }, "xyz", NOW)).toBe(BEFORE.icsPlain);
    }
  });
});

// ---------------------------------------------------------------------------
// Random calendars and a brute-force reading of criteria 1 to 4.

function random(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, int };
}

type Case = {
  people: PersonAvailability[];
  from: string;
  weeks: number;
  filter: DayFilter;
  windowsFor: WindowsFor;
  minMs: number;
  need: number;
  tz: string;
};

const ZONES = ["Europe/Berlin", "America/New_York", "Europe/Istanbul", "Asia/Kolkata", "Pacific/Auckland", "Australia/Lord_Howe"];
// Start days a little before clock changes: Europe and the US in March and
// October/November, Auckland and Lord Howe in April and September/October.
const STARTS = ["2026-03-01", "2026-03-18", "2026-03-28", "2026-06-10", "2026-09-20", "2026-10-12", "2026-10-22"];

// Search hours and timed blocks stay between 06:00 and 22:00 on the wall clock,
// away from the night-time clock changes, on a quarter-hour grid.
const BAND_FROM = 6;
const BAND_TO = 22;
const QUARTER = 15 * MINUTE;
const POINTS = (BAND_TO - BAND_FROM) * 4 + 1;

/** The epoch of each grid point on a day, checking that no clock change falls inside. */
function grid(day: string, tz: string): number[] {
  const base = zonedTime(day, BAND_FROM, tz);
  if (zonedTime(day, BAND_TO, tz) !== base + (POINTS - 1) * QUARTER) throw new Error(`clock change inside the band on ${day} in ${tz}`);
  return Array.from({ length: POINTS }, (_, k) => base + k * QUARTER);
}

/** Wall-clock hours of a grid epoch on a day, for comparing search hours across weeks. */
function wallHours(epoch: number, day: string, c: Case): number {
  return BAND_FROM + (epoch - zonedTime(day, BAND_FROM, c.tz)) / HOUR_MS;
}

function crossesChange(days: string[], tz: string): boolean {
  const offsets = new Set(days.map((d) => zonedTime(d, 12, tz) - Date.parse(`${d}T12:00:00Z`)));
  return offsets.size > 1;
}

/**
 * Up to five people over 1 to 4 weeks from a start day near a clock change.
 * Each person has standing blocks at the same wall-clock time on a weekday,
 * one-off blocks, sometimes all-day, tentative or overnight ones. Search hours
 * mostly repeat by weekday and sometimes differ in a week. "apart" search hours
 * never touch; "any" also gives touching and overlapping ones.
 */
function randomCase(seed: number, windowKind: "apart" | "any", minWeeks: number, maxWeeks: number, needAbove = 0): Case {
  const r = random(seed);
  const tz = ZONES[r.int(0, ZONES.length - 1)];
  const from = plusDays(STARTS[r.int(0, STARTS.length - 1)], r.int(0, 13));
  const weeks = r.int(minWeeks, maxWeeks);
  const filter = (["all", "weekdays", "weekends"] as const)[r.int(0, 2)];
  const span = Array.from({ length: 7 * weeks + 2 }, (_, i) => plusDays(from, i - 1));
  const grids = new Map(span.map((d) => [d, grid(d, tz)]));
  const q = (day: string, quarters: number) => grids.get(day)![quarters - 4 * BAND_FROM];

  const hoursList = (): [number, number][] => {
    const kind = r.int(0, 5);
    if (kind === 0) return [];
    const a = r.int(24, 56);
    if (kind <= 2) return [[a, r.int(a + 4, 88)]];
    const b = r.int(a + 4, 72);
    if (windowKind === "apart" || r.next() < 0.4) {
      const c = r.int(b + 1, 84);
      return [
        [a, b],
        [c, r.int(c + 4, 88)],
      ];
    }
    const c = r.next() < 0.5 ? b : r.int(a + 1, b - 1);
    return [
      [a, b],
      [c, r.int(Math.max(b, c) + 1, 88)],
    ];
  };
  const usual = Array.from({ length: 7 }, hoursList);
  const windows = new Map<string, Interval[]>();
  for (const day of span.slice(1)) {
    let list = r.next() < 0.75 ? usual[dayOfWeek(day)] : hoursList();
    if (r.next() < 0.3) list = [...list].reverse();
    windows.set(
      day,
      list.map(([s, e]): Interval => [q(day, s), q(day, e)]),
    );
  }

  const people = Array.from({ length: r.int(1, 5) }, (_, i) => {
    const standing = Array.from({ length: 7 }, () =>
      Array.from({ length: r.int(0, 2) }, () => {
        const s = r.int(24, 84);
        return [s, Math.min(88, s + r.int(2, 16))] as const;
      }),
    );
    const busy: BusyBlock[] = [];
    for (const day of span.slice(1)) {
      for (const [s, e] of standing[dayOfWeek(day)]) if (r.next() < 0.85) busy.push(block(q(day, s), q(day, e)));
      for (let k = r.int(0, 2); k > 0; k--) {
        const s = r.int(24, 84);
        busy.push(block(q(day, s), q(day, Math.min(88, s + r.int(1, 12))), r.next() < 0.2 ? { tentative: true } : {}));
      }
      if (r.next() < 0.02) busy.push(allDayOn(day, tz));
      if (r.next() < 0.04) busy.push(block(zonedTime(plusDays(day, -1), r.int(80, 92) / 4, tz), q(day, r.int(24, 36))));
    }
    return person(`P${i}`, busy);
  });
  return {
    people,
    from,
    weeks,
    filter,
    windowsFor: (day) => windows.get(day) ?? [],
    minMs: [15, 30, 45, 60, 90, 120][r.int(0, 5)] * MINUTE,
    need: r.int(1, people.length + needAbove),
    tz,
  };
}

function mergeAll(list: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [s, e] of [...list].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Criteria 1 to 4 read directly: for each occurrence list, every wall-clock
 * range on the grid that lies inside one (joined) search window on every
 * occurrence day, is long enough, has at least `need` people free on every
 * occurrence day, and cannot be extended for them. Slots in range order.
 */
function bruteForce(c: Case, seen?: { differentGroups: number }): NamedWeek[] {
  const need = Math.min(c.need, c.people.length);
  const out: NamedWeek[] = [];
  for (const days of occurrences(c.from, c.weeks, c.filter)) {
    const T = days.map((d) => grid(d, c.tz));
    const windows = days.map((d) => mergeAll(c.windowsFor(d)));
    const inWindow = days.map((_, i) => T[i].map((t) => windows[i].findIndex(([w0, w1]) => w0 <= t && t <= w1)));
    // Blocks near each day, and running counts of busy grid cells.
    const near = c.people.map((p) => days.map((_, i) => p.busy.filter((b) => b.start <= T[i][POINTS - 1] && b.end >= T[i][0])));
    const busyBefore = c.people.map((_, pi) =>
      days.map((_, i) => {
        const counts = [0];
        for (let k = 0; k < POINTS - 1; k++) {
          const busy = near[pi][i].some((b) => b.start < T[i][k + 1] && b.end > T[i][k]);
          counts.push(counts[k] + (busy ? 1 : 0));
        }
        return counts;
      }),
    );
    const slots: NamedSlot[] = [];
    let differentGroups = false;
    for (let s = 0; s < POINTS; s++) {
      for (let e = s + 1; e < POINTS; e++) {
        if (T[0][e] - T[0][s] < c.minMs) continue;
        if (!days.every((_, i) => inWindow[i][s] >= 0 && inWindow[i][s] === inWindow[i][e])) continue;
        const freeOn = (pi: number, i: number) => busyBefore[pi][i][e] - busyBefore[pi][i][s] === 0;
        const free = c.people.map((_, pi) => pi).filter((pi) => days.every((_, i) => freeOn(pi, i)));
        if (free.length < need) {
          if (days.every((_, i) => c.people.filter((_, pi) => freeOn(pi, i)).length >= need)) differentGroups = true;
          continue;
        }
        const startFixed =
          days.some((_, i) => windows[i][inWindow[i][s]][0] === T[i][s]) ||
          free.some((pi) => days.some((_, i) => near[pi][i].some((b) => b.start < T[i][s] && b.end >= T[i][s])));
        const endFixed =
          days.some((_, i) => windows[i][inWindow[i][e]][1] === T[i][e]) ||
          free.some((pi) => days.some((_, i) => near[pi][i].some((b) => b.start <= T[i][e] && b.end > T[i][e])));
        if (!startFixed || !endFixed) continue;
        slots.push({
          slot: [T[0][s], T[0][e]],
          free: free.map((pi) => c.people[pi].name),
          missing: c.people.filter((_, pi) => !free.includes(pi)).map((p) => p.name),
        });
      }
    }
    if (differentGroups && seen) seen.differentGroups++;
    if (slots.length) out.push({ weekday: dayOfWeek(days[0]), days, slots: slots.sort(byRange) });
  }
  return out;
}
