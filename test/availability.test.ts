import { describe, expect, it } from "vitest";
import { almostSlots, commonFree, dayWindow, daysInRange, findSlots, searchWindows, workingIntervals } from "@/lib/availability";
import { HOUR, zonedTime } from "@/lib/time";
import type { PersonAvailability, WorkingHours } from "@/lib/types";

const TZ = "Europe/Istanbul";
const DAY = "2026-10-06";
const at = (h: number, day = DAY) => zonedTime(day, h, TZ);

function person(id: string, busy: [number, number][]): PersonAvailability {
  return {
    id,
    name: id,
    team: null,
    color: "#2f7de1",
    timezone: TZ,
    email: `${id}@example.com`,
    calendars: ["Job"],
    data: "ok",
    pending: false,
    stale: false,
    busy: busy.map(([s, e]) => ({ start: at(s), end: at(e), calendar: 0, label: "Job" })),
  };
}

const ahmet = person("ahmet", [[9, 13], [14, 18]]);
const elif = person("elif", [[10, 17]]);
const mert = person("mert", [[8, 12], [13, 16.5], [19, 20]]);
const hours = { start: 8, end: 22 };
const windowsFor = (day: string) => [dayWindow(day, hours, TZ)];

describe("availability", () => {
  it("finds time when everyone is free within the search hours", () => {
    const free = commonFree([ahmet, elif, mert], [dayWindow(DAY, hours, TZ)]);
    expect(free).toEqual([[at(18), at(19)], [at(20), at(22)]]);
  });

  it("only offers gaps long enough and not in the past", () => {
    const res = findSlots([ahmet, elif, mert], [DAY], windowsFor, 90 * 60_000, at(0));
    expect(res).toEqual([{ day: DAY, slots: [[at(20), at(22)]] }]);
    expect(findSlots([ahmet, elif, mert], [DAY], windowsFor, HOUR, at(20.5))).toEqual([
      { day: DAY, slots: [[at(20.5), at(22)]] },
    ]);
  });

  it("suggests slots that work for everyone but one person", () => {
    const almost = almostSlots([ahmet, elif, mert], [DAY], windowsFor, HOUR, at(0));
    expect(almost.map((a) => [a.missing.id, a.slot])).toContainEqual(["mert", [at(19), at(20)]]);
    expect(almost.every((a) => a.slot[1] - a.slot[0] >= HOUR)).toBe(true);
  });

  it("filters weekdays and weekends", () => {
    // 2026-10-10 is a Saturday.
    expect(daysInRange("2026-10-09", 4, "weekdays")).toEqual(["2026-10-09", "2026-10-12"]);
    expect(daysInRange("2026-10-09", 4, "weekends")).toEqual(["2026-10-10", "2026-10-11"]);
  });
});

describe("working hours", () => {
  // 10:00–18:00 Türkiye time, Monday to Friday. 2026-10-06 is a Tuesday.
  const wh: WorkingHours = { timezone: TZ, start: 10, end: 18, days: [1, 2, 3, 4, 5] };
  const london = (h: number, day = DAY) => zonedTime(day, h, "Europe/London");

  it("are the same hours for a viewer in the company's zone", () => {
    expect(workingIntervals(DAY, TZ, wh)).toEqual([[at(10), at(18)]]);
  });

  it("move to the viewer's wall clock elsewhere", () => {
    // October: Istanbul is UTC+3, London UTC+1, so 10:00 Türkiye time is 08:00 in London.
    expect(workingIntervals(DAY, "Europe/London", wh)).toEqual([[london(8), london(16)]]);
  });

  it("skip days off, including ones that only start in the company's zone", () => {
    expect(workingIntervals("2026-10-10", TZ, wh)).toEqual([]);
    // Monday 10:00 in Istanbul is still Sunday 21:00 in Honolulu.
    const sunday = workingIntervals("2026-10-11", "Pacific/Honolulu", wh);
    expect(sunday).toEqual([[at(10, "2026-10-12"), zonedTime("2026-10-12", 0, "Pacific/Honolulu")]]);
  });

  it("cut the search hours unless off-hours are shown", () => {
    expect(searchWindows(DAY, hours, TZ, wh)).toEqual([[at(10), at(18)]]);
    expect(searchWindows(DAY, hours, TZ, null)).toEqual([[at(8), at(22)]]);
    expect(searchWindows(DAY, { start: 15, end: 22 }, TZ, wh)).toEqual([[at(15), at(18)]]);
  });

  it("limit found slots to working hours", () => {
    const within = (day: string) => searchWindows(day, hours, TZ, wh);
    // The only shared gaps are 18–19 and 20–22, both after work.
    expect(findSlots([ahmet, elif, mert], [DAY], within, HOUR, at(0))).toEqual([]);
  });
});

describe("people whose free time isn't known", () => {
  it("are named in the note and never treated as free", async () => {
    const { hasData, leftOutNote, noDataText } = await import("@/lib/availability");
    const can = { ...person("can", []), name: "Can Öztürk", data: "signInAgain" as const };
    expect(hasData(can)).toBe(false);
    expect(noDataText(can)?.short).toBe("Needs to sign in");
    expect(leftOutNote([ahmet, can])).toBe("Not counted: Can (needs to sign in again).");
    expect(leftOutNote([ahmet, elif])).toBeNull();
  });
});
