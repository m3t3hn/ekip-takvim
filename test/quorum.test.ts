// Quorum search in Find a time: "at least N of the M people". Written from the
// acceptance criteria of the feature, not from the implementation.

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  dayWindow,
  effectiveNeed,
  findQuorumSlots,
  findSlots,
  needChoices,
  parseNeed,
  quorumNote,
  type WindowsFor,
} from "@/lib/availability";
import type { Interval } from "@/lib/intervals";
import { addDays, dayStart, MINUTE, zonedTime } from "@/lib/time";
import type { BusyBlock, PersonAvailability } from "@/lib/types";

const TZ = "Europe/Istanbul";
const DAY = "2026-10-06";
const at = (h: number, day = DAY) => zonedTime(day, h, TZ);

function block(from: number, to: number, extra: Partial<BusyBlock> = {}, day = DAY): BusyBlock {
  return { start: at(from, day), end: at(to, day), calendar: 0, label: "Job", ...extra };
}

/** Busy from-to pairs, in hours on DAY. */
const busy = (...pairs: [number, number][]) => pairs.map(([s, e]) => block(s, e));

function person(name: string, blocks: BusyBlock[] = []): PersonAvailability {
  const id = name.toLowerCase().replace(/\s+/g, "-");
  return {
    id,
    name,
    team: null,
    color: "#2f7de1",
    timezone: TZ,
    email: `${id}@example.com`,
    calendars: ["Job"],
    data: "ok",
    pending: false,
    stale: false,
    busy: blocks,
  };
}

/** The same search hours on every day. */
const hoursEachDay = (from: number, to: number): WindowsFor => (day) => [[at(from, day), at(to, day)]];

const BEFORE_ALL = at(0);

type Result = ReturnType<typeof findQuorumSlots>;
type NamedSlot = { slot: Interval; free: string[]; missing: string[] };

/** The result with people as names, for readable comparisons. */
function named(result: Result): { day: string; slots: NamedSlot[] }[] {
  return result.map((d) => ({
    day: d.day,
    slots: d.slots.map((s) => ({
      slot: s.slot,
      free: s.free.map((p) => p.name),
      missing: s.missing.map((p) => p.name),
    })),
  }));
}

const row = (from: number, to: number, free: string[], missing: string[] = []): NamedSlot => ({
  slot: [at(from), at(to)],
  free,
  missing,
});

describe("findQuorumSlots: shape (criterion 1)", () => {
  it("takes findSlots' parameters plus need and returns days of { slot, free, missing }", () => {
    // Checked by `npm run typecheck`: tsc compiles this file.
    type FirstFive<A> = A extends [infer A1, infer A2, infer A3, infer A4, infer A5, ...unknown[]]
      ? [A1, A2, A3, A4, A5]
      : never;
    expectTypeOf<FirstFive<Parameters<typeof findQuorumSlots>>>().toEqualTypeOf<Parameters<typeof findSlots>>();
    expectTypeOf(findQuorumSlots).parameter(5).toEqualTypeOf<number>();
    expectTypeOf(findQuorumSlots).returns.toEqualTypeOf<
      { day: string; slots: { slot: [number, number]; free: PersonAvailability[]; missing: PersonAvailability[] }[] }[]
    >();
  });

  it("gives one entry per day that has a slot, in the order of days", () => {
    const [d1, d2, d3] = ["2026-10-05", "2026-10-06", "2026-10-07"];
    const a = person("A", [block(9, 17, {}, d1), block(9, 13, {}, d2)]);
    const b = person("B", [block(9, 17, {}, d1), block(12, 13, {}, d3)]);
    const c = person("C", [block(9, 17, {}, d1), block(9, 17, {}, d3)]);
    const res = findQuorumSlots([a, b, c], [d3, d1, d2], hoursEachDay(9, 17), 60 * MINUTE, at(0, d1), 2);
    expect(res).toEqual([
      {
        day: d3,
        slots: [
          { slot: [at(9, d3), at(12, d3)], free: [a, b], missing: [c] },
          { slot: [at(13, d3), at(17, d3)], free: [a, b], missing: [c] },
        ],
      },
      {
        day: d2,
        slots: [
          { slot: [at(9, d2), at(17, d2)], free: [b, c], missing: [a] },
          { slot: [at(13, d2), at(17, d2)], free: [a, b, c], missing: [] },
        ],
      },
    ]);
  });
});

describe("findQuorumSlots: the worked example (criterion 4)", () => {
  const A = person("A", busy([9, 10], [12, 17]));
  const B = person("B", busy([9, 10], [12, 17]));
  const C = person("C", busy([9, 10], [12, 17]));
  const D = person("D", busy([9, 10], [11, 17]));
  const search = (minMinutes: number, need: number) =>
    findQuorumSlots([A, B, C, D], [DAY], hoursEachDay(9, 17), minMinutes * MINUTE, BEFORE_ALL, need);

  it("need 3, 60 minutes: 10–11 with everyone, then 10–12 without D", () => {
    expect(search(60, 3)).toEqual([
      {
        day: DAY,
        slots: [
          { slot: [at(10), at(11)], free: [A, B, C, D], missing: [] },
          { slot: [at(10), at(12)], free: [A, B, C], missing: [D] },
        ],
      },
    ]);
  });

  it("90 minutes keeps only the second", () => {
    expect(search(90, 3)).toEqual([
      { day: DAY, slots: [{ slot: [at(10), at(12)], free: [A, B, C], missing: [D] }] },
    ]);
  });

  it("need 4 keeps only the first", () => {
    expect(search(60, 4)).toEqual([
      { day: DAY, slots: [{ slot: [at(10), at(11)], free: [A, B, C, D], missing: [] }] },
    ]);
  });

  it("its slots read as quorum notes", () => {
    const [{ slots }] = search(60, 3);
    expect(slots.map(quorumNote)).toEqual(["All 4 free", "3 of 4 free · without D"]);
  });
});

describe("findQuorumSlots: which ranges are listed (criteria 2, 3 and 6)", () => {
  const run = (people: PersonAvailability[], need: number, minMinutes = 60, notBefore = BEFORE_ALL, windows = hoursEachDay(9, 17)) =>
    named(findQuorumSlots(people, [DAY], windows, minMinutes * MINUTE, notBefore, need));

  it("lists every end for one start, longest with the fewest people", () => {
    const people = [
      person("A", busy([9, 10], [16, 17])),
      person("B", busy([9, 10], [14, 17])),
      person("C", busy([9, 10], [12, 17])),
      person("D", busy([9, 17])),
    ];
    const ladder = [
      row(10, 12, ["A", "B", "C"], ["D"]),
      row(10, 14, ["A", "B"], ["C", "D"]),
      row(10, 16, ["A"], ["B", "C", "D"]),
    ];
    expect(run(people, 1)).toEqual([{ day: DAY, slots: ladder }]);
    expect(run(people, 2)).toEqual([{ day: DAY, slots: ladder.slice(0, 2) }]);
    expect(run(people, 3)).toEqual([{ day: DAY, slots: ladder.slice(0, 1) }]);
  });

  it("does not start a group where none of its runs start, nor end it where none end", () => {
    // A and B are free 10–13; C only 11–12. [11, 13) and [10, 12) can both be
    // extended for the people free in them, so neither is listed.
    const people = [
      person("A", busy([9, 10], [13, 17])),
      person("B", busy([9, 10], [13, 17])),
      person("C", busy([9, 11], [12, 17])),
    ];
    expect(run(people, 2)).toEqual([
      { day: DAY, slots: [row(10, 13, ["A", "B"], ["C"]), row(11, 12, ["A", "B", "C"])] },
    ]);
  });

  it("runs to the window's edges and orders a shared start by more people free", () => {
    const people = [person("A"), person("B"), person("C", busy([12, 13]))];
    expect(run(people, 2)).toEqual([
      {
        day: DAY,
        slots: [row(9, 12, ["A", "B", "C"]), row(9, 17, ["A", "B"], ["C"]), row(13, 17, ["A", "B", "C"])],
      },
    ]);
  });

  it("keeps each slot inside one window", () => {
    const twoWindows: WindowsFor = (day) => [
      [at(9, day), at(12, day)],
      [at(13, day), at(17, day)],
    ];
    const people = [person("A"), person("B"), person("C", busy([10, 11]))];
    expect(run(people, 2, 60, BEFORE_ALL, twoWindows)).toEqual([
      {
        day: DAY,
        slots: [
          row(9, 10, ["A", "B", "C"]),
          row(9, 12, ["A", "B"], ["C"]),
          row(11, 12, ["A", "B", "C"]),
          row(13, 17, ["A", "B", "C"]),
        ],
      },
    ]);
  });

  it("counts tentative and all-day blocks as busy", () => {
    const allDay = { start: dayStart(DAY, TZ), end: dayStart(addDays(DAY, 1), TZ), calendar: 0, label: "Job", allDay: true };
    const people = [
      person("A", busy([9, 10], [12, 17])),
      person("B", busy([9, 10], [12, 17])),
      person("C", busy([9, 10], [12, 17])),
      person("D", [block(9, 10), block(11, 17, { tentative: true })]),
      person("E", [allDay]),
    ];
    expect(run(people, 3)).toEqual([
      { day: DAY, slots: [row(10, 11, ["A", "B", "C", "D"], ["E"]), row(10, 12, ["A", "B", "C"], ["D", "E"])] },
    ]);
  });

  it("cuts off time before notBefore when it falls in a free run", () => {
    const people = [person("A", busy([12, 17])), person("B", busy([12, 17])), person("C", busy([9, 17]))];
    expect(run(people, 2, 60, at(10.5))).toEqual([{ day: DAY, slots: [row(10.5, 12, ["A", "B"], ["C"])] }]);
    expect(run(people, 2, 120, at(10.5))).toEqual([]);
    expect(run(people, 2, 60, at(13))).toEqual([]);
  });

  it("cuts off time before notBefore when it falls in a busy block", () => {
    const people = [person("A", busy([9, 11])), person("B"), person("C", busy([9, 17]))];
    expect(run(people, 1, 60, at(10))).toEqual([
      { day: DAY, slots: [row(10, 17, ["B"], ["A", "C"]), row(11, 17, ["A", "B"], ["C"])] },
    ]);
    expect(run(people, 2, 60, at(10))).toEqual([{ day: DAY, slots: [row(11, 17, ["A", "B"], ["C"])] }]);
  });

  it("names someone free for less than the length as missing", () => {
    const people = [person("A"), person("B"), person("C", busy([9, 10], [10.5, 17]))];
    expect(run(people, 2, 60)).toEqual([{ day: DAY, slots: [row(9, 17, ["A", "B"], ["C"])] }]);
    // Exactly the length is long enough.
    expect(run(people, 2, 30)).toEqual([
      { day: DAY, slots: [row(9, 17, ["A", "B"], ["C"]), row(10, 10.5, ["A", "B", "C"])] },
    ]);
  });

  it("keeps the input order in free and missing", () => {
    const people = [person("D"), person("A", busy([9, 17])), person("C"), person("B", busy([9, 17]))];
    expect(run(people, 2)).toEqual([{ day: DAY, slots: [row(9, 17, ["D", "C"], ["A", "B"])] }]);
  });

  it("matches a brute-force reading of the criteria on random calendars", () => {
    const seen = { slots: 0, sharedStart: 0, overlapping: 0, missing: 0, cutAtNotBefore: 0, needAtLeastAll: 0 };
    for (let seed = 1; seed <= 1000; seed++) {
      const c = randomCase(seed, "apart");
      const want = bruteForce(c);
      expect(named(findQuorumSlots(c.people, c.days, c.windowsFor, c.minMs, c.notBefore, c.need)), `seed ${seed}`).toEqual(
        want,
      );
      if (c.need >= c.people.length) seen.needAtLeastAll++;
      for (const { slots } of want) {
        seen.slots += slots.length;
        slots.forEach((s, i) => {
          if (s.missing.length) seen.missing++;
          if (s.slot[0] === c.notBefore) seen.cutAtNotBefore++;
          if (i > 0 && slots[i - 1].slot[0] === s.slot[0]) seen.sharedStart++;
          if (slots.some((o, j) => j !== i && o.slot[0] < s.slot[1] && o.slot[1] > s.slot[0])) seen.overlapping++;
        });
      }
    }
    // The random calendars must reach the cases the criteria are about
    // (seeds 1–1000 give 2561 slots: 570 sharing a start, 1586 overlapping
    // another, 1589 with someone missing, 49 starting at notBefore; 528 rounds
    // ask for everyone).
    expect(seen.slots).toBeGreaterThan(1200);
    expect(seen.sharedStart).toBeGreaterThan(250);
    expect(seen.overlapping).toBeGreaterThan(750);
    expect(seen.missing).toBeGreaterThan(750);
    expect(seen.cutAtNotBefore).toBeGreaterThan(20);
    expect(seen.needAtLeastAll).toBeGreaterThan(250);
  });
});

describe("findQuorumSlots: need at or above everyone (criterion 5)", () => {
  it("gives findSlots' slots with nobody missing", () => {
    const people = [person("A", busy([10, 11])), person("B", busy([13, 14.5])), person("C")];
    for (const need of [3, 4, 10]) {
      const res = findQuorumSlots(people, [DAY], hoursEachDay(9, 17), 60 * MINUTE, at(9.25), need);
      expect(res).toEqual([
        {
          day: DAY,
          slots: [
            { slot: [at(11), at(13)], free: people, missing: [] },
            { slot: [at(14.5), at(17)], free: people, missing: [] },
          ],
        },
      ]);
      expect(res.map((d) => ({ day: d.day, slots: d.slots.map((s) => s.slot) }))).toEqual(
        findSlots(people, [DAY], hoursEachDay(9, 17), 60 * MINUTE, at(9.25)),
      );
    }
  });

  it("treats touching windows as findSlots does", () => {
    const touching: WindowsFor = (day) => [
      [at(9, day), at(12, day)],
      [at(12, day), at(17, day)],
    ];
    const people = [person("A", busy([9.5, 11])), person("B")];
    const all = findSlots(people, [DAY], touching, 60 * MINUTE, BEFORE_ALL);
    // findSlots joins the windows, so a slot runs across 12:00.
    expect(all).toEqual([{ day: DAY, slots: [[at(11), at(17)]] }]);
    for (const need of [2, 3]) {
      const res = findQuorumSlots(people, [DAY], touching, 60 * MINUTE, BEFORE_ALL, need);
      expect(res).toEqual([{ day: DAY, slots: [{ slot: [at(11), at(17)], free: people, missing: [] }] }]);
    }
  });

  it("finds nothing without people, as findSlots does", () => {
    expect(findSlots([], [DAY], hoursEachDay(9, 17), 60 * MINUTE, BEFORE_ALL)).toEqual([]);
    expect(findQuorumSlots([], [DAY], hoursEachDay(9, 17), 60 * MINUTE, BEFORE_ALL, 2)).toEqual([]);
  });

  it("matches findSlots on random calendars, touching and overlapping windows included", () => {
    let slots = 0;
    let acrossWindows = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const c = randomCase(seed, "any");
      const all = findSlots(c.people, c.days, c.windowsFor, c.minMs, c.notBefore);
      for (const { day, slots: found } of all) {
        slots += found.length;
        const windows = c.windowsFor(day);
        acrossWindows += found.filter(([s, e]) => !windows.some(([w0, w1]) => w0 <= s && e <= w1)).length;
      }
      for (const need of [c.people.length, c.people.length + 1, c.people.length + 3]) {
        const res = findQuorumSlots(c.people, c.days, c.windowsFor, c.minMs, c.notBefore, need);
        expect(res.map((d) => ({ day: d.day, slots: d.slots.map((s) => s.slot) })), `seed ${seed}, need ${need}`).toEqual(all);
        const notEveryone = res.flatMap((d) => d.slots).filter((s) => s.missing.length > 0 || s.free.length !== c.people.length);
        expect(notEveryone, `seed ${seed}, need ${need}`).toEqual([]);
      }
    }
    // Seeds 1–600 give 557 slots, 72 of them across two joined windows.
    expect(slots).toBeGreaterThan(280);
    expect(acrossWindows).toBeGreaterThan(35);
  });
});

describe("findQuorumSlots: speed (criterion 7)", () => {
  it("handles 15 people with 8 blocks a day over 31 days in under a second", () => {
    const r = random(2026);
    const days = Array.from({ length: 31 }, (_, i) => addDays("2026-10-01", i));
    const people = Array.from({ length: 15 }, (_, i) =>
      person(
        `Person ${i}`,
        days.flatMap((day) =>
          Array.from({ length: 8 }, () => {
            const from = r.int(32, 84) / 4;
            return block(from, from + r.int(1, 8) / 4, {}, day);
          }),
        ),
      ),
    );
    expect(people.every((p) => p.busy.length === 8 * 31)).toBe(true);
    const windows = (day: string) => [dayWindow(day, { start: 8, end: 22 }, TZ)];
    const started = performance.now();
    const res = findQuorumSlots(people, days, windows, 30 * MINUTE, at(0, days[0]), 8);
    const took = performance.now() - started;
    expect(res.length).toBeGreaterThan(20);
    expect(took).toBeLessThan(1000);
  });
});

describe("needChoices (criterion 8)", () => {
  it("counts down from one below everyone to 2", () => {
    expect(needChoices(9)).toEqual([8, 7, 6, 5, 4, 3, 2]);
    expect(needChoices(4)).toEqual([3, 2]);
    expect(needChoices(3)).toEqual([2]);
  });

  it("offers nothing under 3 people", () => {
    for (const count of [2, 1, 0, -1]) expect(needChoices(count), `count ${count}`).toEqual([]);
  });
});

describe("effectiveNeed (criterion 9)", () => {
  it("keeps a whole number from 2 up to one below everyone", () => {
    expect(effectiveNeed(5, 9)).toBe(5);
    expect(effectiveNeed(2, 9)).toBe(2);
    expect(effectiveNeed(8, 9)).toBe(8);
    expect(effectiveNeed(2, 3)).toBe(2);
  });

  it("means everyone (null) otherwise", () => {
    const cases: [number | null, number][] = [
      [null, 9],
      [9, 9],
      [10, 9],
      [1, 9],
      [0, 9],
      [-3, 9],
      [2.5, 9],
      [Number.NaN, 9],
      [Number.POSITIVE_INFINITY, 9],
      [2, 2],
      [3, 3],
      [2, 0],
    ];
    for (const [need, count] of cases) expect(effectiveNeed(need, count), `need ${need} of ${count}`).toBeNull();
  });
});

describe("parseNeed (criterion 10)", () => {
  it("reads a string of digits worth 2 or more", () => {
    expect(parseNeed("5")).toBe(5);
    expect(parseNeed("2")).toBe(2);
    expect(parseNeed("12")).toBe(12);
    expect(parseNeed("02")).toBe(2);
  });

  it("returns null for anything else", () => {
    const cases = [undefined, "", "0", "1", "-3", "2.5", "abc", "5x", " 5", "5 ", "+5", "1e3", "0x10", "00", "01"];
    for (const raw of cases) expect(parseNeed(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe("quorumNote (criterion 11)", () => {
  const people = (...names: string[]) => names.map((n) => person(n));

  it("says how many are free and who is missing, by first name", () => {
    expect(
      quorumNote({ free: people("Ahmet", "Elif", "Mert", "Zeynep", "Ali"), missing: people("Can Demir", "Deniz") }),
    ).toBe("5 of 7 free · without Can, Deniz");
    expect(quorumNote({ free: people("Ahmet", "Elif Su"), missing: people("Mert Kaya", "Can Demir", "Ali Veli") })).toBe(
      "2 of 5 free · without Mert, Can, Ali",
    );
  });

  it("says all are free when nobody is missing", () => {
    expect(quorumNote({ free: people("Ahmet Yılmaz", "Elif", "Mert", "Zeynep"), missing: [] })).toBe("All 4 free");
  });
});

// ---------------------------------------------------------------------------
// Random calendars and a brute-force reading of criteria 2, 3, 5 and 6.

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
  days: string[];
  windowsFor: WindowsFor;
  minMs: number;
  notBefore: number;
  need: number;
};

const RANDOM_DAYS = ["2026-10-05", "2026-10-06", "2026-10-07"];

/**
 * Up to six people over three days on a quarter-hour grid; notBefore on a
 * five-minute grid. "apart" windows never touch; "any" also gives touching and
 * overlapping ones.
 */
function randomCase(seed: number, windowKind: "apart" | "any"): Case {
  const r = random(seed);
  const quarter = (q: number, day: string) => at(q / 4, day);
  const windows = new Map<string, Interval[]>();
  for (const day of RANDOM_DAYS) {
    const kind = r.int(0, 3);
    let list: [number, number][] = [];
    if (kind === 1) {
      const a = r.int(28, 56);
      list = [[a, r.int(a + 4, 84)]];
    } else if (kind >= 2) {
      const a = r.int(28, 44);
      const b = r.int(a + 4, 56);
      if (windowKind === "apart" || kind === 2) {
        const c = r.int(b + 1, 72);
        list = [
          [a, b],
          [c, r.int(c + 4, 84)],
        ];
      } else {
        const c = r.next() < 0.5 ? b : r.int(a + 1, b - 1);
        list = [
          [a, b],
          [c, r.int(Math.max(b, c) + 1, 84)],
        ];
      }
      if (r.next() < 0.3) list.reverse();
    }
    windows.set(
      day,
      list.map(([s, e]): Interval => [quarter(s, day), quarter(e, day)]),
    );
  }
  let days = RANDOM_DAYS.filter(() => r.next() < 0.8);
  if (days.length === 0) days = [RANDOM_DAYS[r.int(0, 2)]];
  if (r.next() < 0.5) days.reverse();

  const people = Array.from({ length: r.int(1, 6) }, (_, i) =>
    person(
      `P${i}`,
      RANDOM_DAYS.flatMap((day) =>
        Array.from({ length: r.int(0, 4) }, (): BusyBlock => {
          if (r.next() < 0.04) {
            return { start: dayStart(day, TZ), end: dayStart(addDays(day, 1), TZ), calendar: 0, label: "Job", allDay: true };
          }
          const from = r.int(24, 84);
          return {
            start: quarter(from, day),
            end: quarter(from + r.int(1, 16), day),
            calendar: 0,
            label: "Job",
            ...(r.next() < 0.2 ? { tentative: true } : {}),
          };
        }),
      ),
    ),
  );
  const notBefore =
    r.next() < 0.4 ? at(0, RANDOM_DAYS[0]) : at(6, RANDOM_DAYS[0]) + r.int(0, (64 * 60) / 5) * 5 * MINUTE;
  const minMs = [15, 30, 45, 60, 90, 120, 180][r.int(0, 6)] * MINUTE;
  return {
    people,
    days,
    windowsFor: (day) => windows.get(day) ?? [],
    minMs,
    notBefore,
    need: r.int(1, people.length + 1),
  };
}

/**
 * Criterion 2 read directly, for windows that never touch: every range
 * between two boundary points that lies in a window (after notBefore), is long
 * enough, has at least `need` people free and cannot be extended for them;
 * criterion 3 for free and missing; criterion 6 for the order; criterion 5 for
 * a need above the number of people.
 */
function bruteForce(c: Case): { day: string; slots: NamedSlot[] }[] {
  const { people, minMs, notBefore } = c;
  const need = Math.min(c.need, people.length);
  const busyDuring = (p: PersonAvailability, s: number, e: number) => p.busy.some((b) => b.start < e && b.end > s);
  const out: { day: string; slots: NamedSlot[] }[] = [];
  for (const day of c.days) {
    const slots: (NamedSlot & { count: number })[] = [];
    for (const [w0, w1] of c.windowsFor(day)) {
      const ws = Math.max(w0, notBefore);
      const we = w1;
      if (we <= ws) continue;
      const inside = people.flatMap((p) => p.busy.flatMap((b) => [b.start, b.end])).filter((t) => t > ws && t < we);
      const points = [...new Set([ws, we, ...inside])].sort((x, y) => x - y);
      for (const s of points) {
        for (const e of points) {
          if (e - s < minMs || e <= s) continue;
          const free = people.filter((p) => !busyDuring(p, s, e));
          if (free.length < need) continue;
          const cannotStartEarlier = s === ws || free.some((p) => p.busy.some((b) => b.end === s && b.start < s));
          const cannotEndLater = e === we || free.some((p) => p.busy.some((b) => b.start === e && b.end > e));
          if (!cannotStartEarlier || !cannotEndLater) continue;
          slots.push({
            slot: [s, e],
            free: free.map((p) => p.name),
            missing: people.filter((p) => !free.includes(p)).map((p) => p.name),
            count: free.length,
          });
        }
      }
    }
    slots.sort((x, y) => x.slot[0] - y.slot[0] || y.count - x.count);
    if (slots.length) out.push({ day, slots: slots.map(({ slot, free, missing }) => ({ slot, free, missing })) });
  }
  return out;
}
