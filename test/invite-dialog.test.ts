// The invite dialog opened from a row of the weekly search in Find a time.
// Review finding M1: the dialog ticked and showed people by the first meeting
// only, so someone the row lists as missing (busy in a later week) was ticked,
// shown as free and added as a guest to the whole Google Calendar series.
// Written from that finding and the weekly criteria; the dialog's code was read
// only for its props.
//
// The suite runs in node without a DOM: the dialog is rendered with React's
// server renderer, and its buttons are pressed by calling the handlers the
// dialog gave them.

import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InviteDialog } from "@/components/invite-dialog";
import { findWeeklySlots, type QuorumSlot, type WindowsFor } from "@/lib/availability";
import type { BusyBlock, PersonAvailability } from "@/lib/types";

const MIN = 60_000;

// What GET /api/availability sends the dialog's hook: `days` calendar days
// (1 to 62) from `start` in `tz`, with only the busy blocks that overlap them.
// Times are worked out with Intl alone, not with the app's helpers.
const api = vi.hoisted(() => {
  const plusDays = (day: string, n: number) =>
    new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const formats = new Map<string, Intl.DateTimeFormat>();
  /** How far ahead of UTC the clock in `tz` is at `t`, in ms. */
  const offset = (t: number, tz: string) => {
    let f = formats.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      formats.set(tz, f);
    }
    const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  /** The moment the clock in `tz` shows `minutes` past midnight on `day`. */
  const wall = (day: string, minutes: number, tz: string) => {
    const naive = Date.parse(`${day}T00:00:00Z`) + minutes * 60_000;
    return naive - offset(naive - offset(naive, tz), tz);
  };
  return { people: [] as PersonAvailability[], plusDays, offset, wall };
});

vi.mock("@/components/hooks", () => ({
  useAvailability: (start: string, days: number, tz: string) => {
    const reload = () => {};
    if (!Number.isInteger(days) || days < 1 || days > 62) {
      return { data: null, error: "Use ?start=YYYY-MM-DD&days=1..62", loading: false, reload };
    }
    const from = api.wall(start, 0, tz);
    const to = api.wall(api.plusDays(start, days), 0, tz);
    return {
      data: {
        timezone: tz,
        start,
        days,
        syncedAt: 0,
        coverage: { from: start, to: api.plusDays(start, 61) },
        people: api.people.map((p) => ({ ...p, busy: p.busy.filter((b) => b.start < to && b.end > from) })),
      },
      error: null,
      loading: false,
      reload,
    };
  },
}));

const TZ = "Europe/Istanbul"; // UTC+3 all year
const NOW = Date.parse("2026-11-13T09:00:00Z");
const at = (iso: string) => Date.parse(iso);
const names = (list: readonly { name: string }[]) => list.map((p) => p.name);

function person(
  name: string,
  busy: BusyBlock[] = [],
  data: PersonAvailability["data"] = "ok",
  timezone = TZ,
): PersonAvailability {
  const id = name.split(" ")[0].toLowerCase();
  return {
    id,
    name,
    email: `${id}@example.com`,
    team: null,
    calendars: ["Job"],
    color: "#2f7de1",
    timezone,
    busy,
    data,
    pending: false,
    stale: false,
  };
}

const block = (start: string, end: string, title: string): BusyBlock => ({
  start: at(start),
  end: at(end),
  calendar: 0,
  label: "Job",
  title,
});

type Props = Parameters<typeof InviteDialog>[0];
type El = ReactElement<Record<string, unknown>>;

/** Every element of a tree the dialog returned, children included. */
function elements(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as El;
  return [el, ...elements(el.props.children as ReactNode)];
}

const ownText = (el: El) =>
  [el.props.children]
    .flat()
    .filter((c) => typeof c === "string")
    .join("")
    .trim();

const decode = (s: string) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// Renders the dialog and hands each render's tree to `onTree`.
function Harness({ props, onTree }: { props: Props; onTree: (tree: ReactNode) => void }) {
  const tree = InviteDialog(props);
  onTree(tree);
  return tree;
}

type Shown = { name: string; ticked: boolean; status: string };

/**
 * Open the dialog as the app does. `byHand` ticks that person, as a click on
 * their box would, before the dialog is read.
 */
function open(props: Partial<Props> & Pick<Props, "day" | "range">, byHand?: string) {
  const full: Props = {
    defaultMinutes: 60,
    people: api.people,
    tz: TZ,
    zones: [],
    organiser: null,
    now: NOW,
    onClose: () => {},
    ...props,
  };
  let tree: ReactNode = null;
  let clicked = false;
  const onTree = (t: ReactNode) => {
    if (byHand && !clicked) {
      clicked = true;
      const box = elements(t).find((el) => el.props.label === `Invite ${byHand}`);
      if (!box) throw new Error(`No box for ${byHand}`);
      // Ticking during the render makes React render the dialog again with it ticked.
      (box.props.onChange as (on: boolean) => void)(true);
    }
    tree = t;
  };
  const html = renderToStaticMarkup(createElement(Harness, { props: full, onTree })).replace(/<!-- -->/g, "");
  const list = /<ul class="divide-y[^"]*">(.*?)<\/ul>/.exec(html)?.[1];
  const who: Shown[] = (list ?? "")
    .split(/<li[\s>]/)
    .slice(1)
    .map((li) => {
      const texts = li
        .replace(/<svg.*?<\/svg>/g, "")
        .split(/<[^>]*>/)
        .map((t) => decode(t).trim())
        .filter(Boolean);
      // The last two texts of a row: free or busy, then the address.
      return {
        name: decode(/aria-label="Invite ([^"]*)"/.exec(li)?.[1] ?? "?"),
        ticked: /<input[^>]*\schecked=""/.test(li),
        status: texts[texts.length - 2],
      };
    });
  const warning = />([^<>]*) (?:is|are) busy then\.</.exec(html)?.[1] ?? null;

  /** Press "Google Calendar": the link it opens, or null if it opens none. */
  const google = (): URL | null => {
    const button = elements(tree).find((el) => typeof el.props.onClick === "function" && ownText(el) === "Google Calendar");
    if (!button) throw new Error("No Google Calendar button");
    const openTab = vi.fn();
    vi.stubGlobal("window", { open: openTab });
    try {
      (button.props.onClick as () => void)();
    } finally {
      vi.unstubAllGlobals();
    }
    return openTab.mock.calls.length > 0 ? new URL(String(openTab.mock.calls[0][0])) : null;
  };

  const status = (name: string) => who.find((r) => r.name === name)?.status;
  return { loaded: list !== undefined, who, warning, google, status };
}

// Thursdays from 19 Nov 2026 for 4 weeks, 09:00-18:00 Istanbul time. Ada is
// busy 09:00-10:00 on Thu 3 Dec, the third week, and free the other weeks.
const ada = person("Ada Demir", [block("2026-12-03T06:00:00Z", "2026-12-03T07:00:00Z", "Dentist")]);
const ben = person("Ben Kaya");
const can = person("Can Aksoy");
const team = [ada, ben, can];
const nineToSix = (tz: string): WindowsFor => (day) => [[api.wall(day, 9 * 60, tz), api.wall(day, 18 * 60, tz)]];

/** The Thursday rows of the weekly search "at least 2 of 3", as the schedule lists them. */
function thursdays() {
  const found = findWeeklySlots(team, "2026-11-19", 4, "all", nineToSix(TZ), 60 * MIN, 2, TZ);
  const thu = found.find((w) => w.weekday === 4);
  if (!thu) throw new Error("No Thursday rows");
  return thu;
}

describe("a weekly invite opened from a row (review finding M1)", () => {
  it("does not tick, show as free or invite someone busy at a later meeting", () => {
    api.people = team;
    const thu = thursdays();
    const row = thu.slots.find((s) => s.missing.length > 0) as QuorumSlot;
    // The row reads "2 of 3 free · without Ada", 09:00-18:00.
    expect(row.slot).toEqual([at("2026-11-19T06:00:00Z"), at("2026-11-19T15:00:00Z")]);
    expect(names(row.free)).toEqual(["Ben Kaya", "Can Aksoy"]);
    expect(names(row.missing)).toEqual(["Ada Demir"]);

    // Invite, with the default length of an hour: 09:00-10:00 every Thursday.
    const d = open({ day: thu.days[0], range: row.slot, weekly: { count: 4, timezone: TZ } });
    expect(d.who.map((r) => [r.name, r.ticked])).toEqual([
      ["Ada Demir", false],
      ["Ben Kaya", true],
      ["Can Aksoy", true],
    ]);
    expect(d.status("Ada Demir")).not.toBe("free");
    expect(d.status("Ada Demir")).toMatch(/^busy\b.*Dentist$/);
    expect(d.status("Ben Kaya")).toBe("free");
    expect(d.status("Can Aksoy")).toBe("free");
    expect(d.warning).toBeNull();

    const url = d.google();
    expect(url?.searchParams.get("add")).toBe("ben@example.com,can@example.com");
    expect(url?.searchParams.get("recur")).toBe("RRULE:FREQ=WEEKLY;COUNT=4");
    expect(url?.searchParams.get("ctz")).toBe(TZ);
  });

  it("ticks exactly the row's free people when the meeting is the whole row", () => {
    // Ada's clash is late in the row now: 15:00-16:00 on Thu 3 Dec.
    const late = person("Ada Demir", [block("2026-12-03T12:00:00Z", "2026-12-03T13:00:00Z", "Dentist")]);
    api.people = [late, ben, can];
    const found = findWeeklySlots(api.people, "2026-11-19", 4, "all", nineToSix(TZ), 60 * MIN, 2, TZ);
    const row = found.find((w) => w.weekday === 4)?.slots.find((s) => s.missing.length > 0) as QuorumSlot;
    expect(row.slot).toEqual([at("2026-11-19T06:00:00Z"), at("2026-11-19T15:00:00Z")]);

    const d = open({ day: "2026-11-19", range: row.slot, weekly: { count: 4, timezone: TZ }, defaultMinutes: 9 * 60 });
    expect(d.who.filter((r) => r.ticked).map((r) => r.name)).toEqual(names(row.free));
    expect(d.status("Ada Demir")).toMatch(/^busy\b/);
    expect(d.google()?.searchParams.get("add")).toBe("ben@example.com,can@example.com");
  });

  it("names the weeks a person can't make, or says every week", () => {
    api.people = [
      ada,
      person("Ben Kaya", [
        block("2026-11-26T06:30:00Z", "2026-11-26T07:30:00Z", "Lunch"),
        block("2026-12-10T05:00:00Z", "2026-12-10T06:15:00Z", "Job"),
      ]),
      person(
        "Can Aksoy",
        ["2026-11-19", "2026-11-26", "2026-12-03", "2026-12-10"].map((day) =>
          block(`${day}T06:00:00Z`, `${day}T06:30:00Z`, "Standup"),
        ),
      ),
    ];
    const d = open({
      day: "2026-11-19",
      range: [at("2026-11-19T06:00:00Z"), at("2026-11-19T15:00:00Z")],
      weekly: { count: 4, timezone: TZ },
    });
    expect(d.status("Ada Demir")).toBe("busy Thu 3 Dec · Dentist");
    expect(d.status("Ben Kaya")).toBe("busy Thu 26 Nov, Thu 10 Dec · Lunch, Job");
    expect(d.status("Can Aksoy")).toBe("busy every week · Standup");
    expect(d.who.every((r) => !r.ticked)).toBe(true);
    // Nobody to invite: the link is not opened.
    expect(d.google()).toBeNull();
  });

  it("warns when someone busy at a later meeting is ticked by hand, and then invites them", () => {
    api.people = team;
    const range: [number, number] = [at("2026-11-19T06:00:00Z"), at("2026-11-19T15:00:00Z")];
    const d = open({ day: "2026-11-19", range, weekly: { count: 4, timezone: TZ } }, "Ada Demir");
    expect(d.who.map((r) => [r.name, r.ticked])).toEqual([
      ["Ada Demir", true],
      ["Ben Kaya", true],
      ["Can Aksoy", true],
    ]);
    expect(d.warning).toBe("Ada");
    expect(d.google()?.searchParams.get("add")).toBe("ada@example.com,ben@example.com,can@example.com");
  });

  it("checks the last week of an 8-week series and nothing after it", () => {
    // Thu 7 Jan 2027 is the 8th Thursday from 19 Nov 2026; Thu 14 Jan would be a 9th.
    api.people = [
      person("Ada Demir", [block("2027-01-07T06:00:00Z", "2027-01-07T07:00:00Z", "Dentist")]),
      person("Ben Kaya", [block("2027-01-14T06:00:00Z", "2027-01-14T07:00:00Z", "Job")]),
      can,
    ];
    const d = open({
      day: "2026-11-19",
      range: [at("2026-11-19T06:00:00Z"), at("2026-11-19T15:00:00Z")],
      weekly: { count: 8, timezone: TZ },
    });
    expect(d.loaded).toBe(true);
    expect(d.who.map((r) => [r.name, r.ticked])).toEqual([
      ["Ada Demir", false],
      ["Ben Kaya", true],
      ["Can Aksoy", true],
    ]);
    expect(d.status("Ada Demir")).toBe("busy Thu 7 Jan · Dentist");
    expect(d.status("Ben Kaya")).toBe("free");
    const url = d.google();
    expect(url?.searchParams.get("add")).toBe("ben@example.com,can@example.com");
    expect(url?.searchParams.get("recur")).toBe("RRULE:FREQ=WEEKLY;COUNT=8");
  });

  it("lines the weeks up by the clock across the end of summer time", () => {
    const BERLIN = "Europe/Berlin";
    // Wednesdays 14, 21 and 28 Oct 2026; summer time ends on 25 Oct. The meeting
    // is 09:00-10:00 Berlin time: 07:00Z-08:00Z on 14 and 21 Oct, 08:00Z-09:00Z on 28 Oct.
    api.people = [
      person("Dora Polat", [block("2026-10-28T08:00:00Z", "2026-10-28T09:00:00Z", "Job")], "ok", BERLIN),
      person("Emre Tan", [block("2026-10-28T07:00:00Z", "2026-10-28T08:00:00Z", "Gym")], "ok", BERLIN),
      person("Fatma Uz", [block("2026-10-21T07:00:00Z", "2026-10-21T08:00:00Z", "Course")], "ok", BERLIN),
      person("Gizem Ak", [], "ok", BERLIN),
    ];
    const d = open({
      day: "2026-10-14",
      range: [at("2026-10-14T07:00:00Z"), at("2026-10-14T15:00:00Z")],
      weekly: { count: 3, timezone: BERLIN },
      tz: BERLIN,
      now: at("2026-10-13T09:00:00Z"),
    });
    expect(d.who.map((r) => [r.name, r.ticked, r.status])).toEqual([
      ["Dora Polat", false, "busy Wed 28 Oct · Job"],
      ["Emre Tan", true, "free"],
      ["Fatma Uz", false, "busy Wed 21 Oct · Course"],
      ["Gizem Ak", true, "free"],
    ]);
    const url = d.google();
    expect(url?.searchParams.get("add")).toBe("emre@example.com,gizem@example.com");
    expect(url?.searchParams.get("dates")).toBe("20261014T090000/20261014T100000");
    expect(url?.searchParams.get("ctz")).toBe(BERLIN);
    expect(url?.searchParams.get("recur")).toBe("RRULE:FREQ=WEEKLY;COUNT=3");
  });

  // About half a second here; the timeout leaves room for a slow CI runner.
  it("agrees with the row it was opened from, on random weekly searches", { timeout: 20_000 }, () => {
    const ZONES = ["Europe/Istanbul", "Europe/Berlin", "America/New_York", "Australia/Lord_Howe", "Asia/Kolkata"];
    // Some start a week or three before a clock change in one of the zones:
    // Berlin 29 Mar and 25 Oct 2026, New York 8 Mar and 1 Nov, Lord Howe 5 Apr and 4 Oct.
    const FROMS = ["2026-02-24", "2026-03-17", "2026-03-24", "2026-09-22", "2026-10-13", "2026-10-20", "2026-10-27", "2026-11-19", "2027-01-05"];
    const NAMES = ["Ada Demir", "Ben Kaya", "Can Aksoy", "Dora Polat", "Emre Tan"];
    const TITLES = ["Job", "Lunch", "Gym", "Course", "Dentist"];
    const stats = { rows: 0, missingButFreeInWeekOne: 0, acrossClockChange: 0, withNoDataPerson: 0 };

    for (let seed = 1; seed <= 80; seed++) {
      const r = random(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
      const tz = pick(ZONES);
      const from = pick(FROMS);
      const weeks = pick([2, 3, 4, 6, 8]);
      const known = NAMES.slice(0, 3 + Math.floor(r() * 3)).map((name) => {
        const busy: BusyBlock[] = [];
        // A standing meeting on one weekday most weeks, and odd ones.
        const standing = r() < 0.5 ? { weekday: Math.floor(r() * 7), start: 9 * 60 + 30 * Math.floor(r() * 16), length: 30 * (1 + Math.floor(r() * 3)) } : null;
        for (let i = 0; i < 7 * weeks; i++) {
          const day = api.plusDays(from, i);
          const add = (start: number, length: number, extra: Partial<BusyBlock> = {}) =>
            busy.push({ start: api.wall(day, start, tz), end: api.wall(day, start + length, tz), calendar: 0, label: "Job", title: pick(TITLES), ...extra });
          if (standing && i % 7 === standing.weekday && r() < 0.8) add(standing.start, standing.length);
          if (r() < 0.35) add(8 * 60 + 15 * Math.floor(r() * 44), 15 * (1 + Math.floor(r() * 12)), r() < 0.2 ? { tentative: true } : {});
          if (r() < 0.03) add(0, 24 * 60, { allDay: true });
        }
        return person(name, busy, "ok", tz);
      });
      // Someone whose calendars are still loading is in the dialog but not in the search.
      const shownPeople = [...known];
      if (r() < 0.4) shownPeople.splice(Math.floor(r() * (known.length + 1)), 0, person("Ece Yurt", [], "syncing", tz));
      const need = 1 + Math.floor(r() * known.length);
      const minMs = pick([30, 60]) * MIN;
      const now = api.wall(api.plusDays(from, -1), 12 * 60, tz);
      api.people = shownPeople;

      const rows = findWeeklySlots(known, from, weeks, "all", nineToSix(tz), minMs, need, tz).flatMap((w) =>
        w.slots.map((row) => ({ first: w.days[0], last: w.days[w.days.length - 1], row })),
      );
      // At most 5 rows a search, spread over the list, to keep the suite quick.
      const step = Math.max(1, Math.ceil(rows.length / 5));
      for (const { first, last, row } of rows.filter((_, i) => i % step === 0)) {
        const where = `seed ${seed}, ${tz}, ${weeks} weeks from ${from}, ${first} ${new Date(row.slot[0]).toISOString()}`;
        // The meeting is the whole row: the dialog's default length is the row's.
        const d = open({
          day: first,
          range: row.slot,
          weekly: { count: weeks, timezone: tz },
          defaultMinutes: (row.slot[1] - row.slot[0]) / MIN,
          people: shownPeople,
          tz,
          now,
        });
        expect(d.loaded, where).toBe(true);
        expect(names(d.who), where).toEqual(names(shownPeople));
        expect(d.who.filter((x) => x.ticked).map((x) => x.name), where).toEqual(names(row.free));
        for (const x of d.who) {
          if (row.free.some((p) => p.name === x.name)) expect(x.status, `${where}: ${x.name}`).toBe("free");
          else if (row.missing.some((p) => p.name === x.name)) expect(x.status, `${where}: ${x.name}`).toMatch(/^busy\b/);
          else expect(x.status, `${where}: ${x.name}`).toBe("loading…");
        }
        const url = d.google();
        expect(url?.searchParams.get("add"), where).toBe(row.free.map((p) => p.email).join(","));
        expect(url?.searchParams.get("recur"), where).toBe(`RRULE:FREQ=WEEKLY;COUNT=${weeks}`);

        stats.rows++;
        if (row.missing.some((p) => !p.busy.some((b) => b.start < row.slot[1] && b.end > row.slot[0]))) stats.missingButFreeInWeekOne++;
        if (api.offset(row.slot[0], tz) !== api.offset(api.wall(last, 12 * 60, tz), tz)) stats.acrossClockChange++;
        if (shownPeople.length > known.length) stats.withNoDataPerson++;
      }
    }
    // The random searches reach the case of the finding, and across clock changes.
    expect(stats.rows).toBeGreaterThan(250);
    expect(stats.missingButFreeInWeekOne).toBeGreaterThan(80);
    expect(stats.acrossClockChange).toBeGreaterThan(40);
    expect(stats.withNoDataPerson).toBeGreaterThan(40);
  });
});

describe("a one-off invite", () => {
  it("still goes by its own day: ticks, busy line and link as before", () => {
    api.people = team;
    // On Thu 3 Dec Ada is busy 09:00-10:00, the meeting's hour.
    const onTheDay = open({ day: "2026-12-03", range: [at("2026-12-03T06:00:00Z"), at("2026-12-03T15:00:00Z")] });
    expect(onTheDay.who.map((r) => [r.name, r.ticked, r.status])).toEqual([
      ["Ada Demir", false, "busy · Dentist"],
      ["Ben Kaya", true, "free"],
      ["Can Aksoy", true, "free"],
    ]);
    const url = onTheDay.google();
    expect(url?.searchParams.get("add")).toBe("ben@example.com,can@example.com");
    expect(url?.searchParams.get("dates")).toBe("20261203T060000Z/20261203T070000Z");
    expect(url?.searchParams.has("recur")).toBe(false);
    expect(url?.searchParams.has("ctz")).toBe(false);

    // Two weeks earlier, at the same time, she is free.
    const before = open({ day: "2026-11-19", range: [at("2026-11-19T06:00:00Z"), at("2026-11-19T15:00:00Z")] });
    expect(before.who.map((r) => [r.name, r.ticked, r.status])).toEqual([
      ["Ada Demir", true, "free"],
      ["Ben Kaya", true, "free"],
      ["Can Aksoy", true, "free"],
    ]);
    expect(before.google()?.searchParams.get("add")).toBe("ada@example.com,ben@example.com,can@example.com");
  });
});

/** A small seeded generator (mulberry32), so a failing case can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
