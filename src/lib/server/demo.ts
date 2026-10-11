import { PRESET_COLORS } from "@/lib/colors";
import { addDays, dayKeyOf, dayStart, weekday, zonedTime } from "@/lib/time";
import type { AppConfig } from "./config";
import { db, eventRef, listUsers, resetAll, transaction } from "./db";
import type { Busy } from "./google";

// The demo database: made-up people who "signed in", their calendars and
// busy times, generated around the current week on every start (DEMO_MODE).
// Nothing here talks to Google.
//
// Times are each person's own wall clock. Day offsets count from the demo
// week's Monday (this week's, or next week's at the weekend): 0 = Monday …
// 6 = Sunday, 7 = the Monday after. Within working hours (10:00–18:00
// Türkiye time) this gives:
//   Mon  everyone free 16:00–18:00
//   Tue  nothing for everyone (Ahmet's tentative 16:30); "almost works" without him
//   Wed  everyone free 16:00–17:00 (Zeynep's morning is skipped this week)
//   Thu  everyone free 16:30–18:00
//   Fri  Can is out all day, Mert's standup moved to the afternoon, Zeynep
//        free all day; "almost works" without Can
//   following Mon  Deniz is busy all day; following Thu–Fri Elif is out of office
// Plus evening and weekend events outside working hours and an overnight shift.
// Calendars cover: a primary work calendar each, calendars shared from
// personal accounts, one shared as free/busy only, one not counted, one that
// fails to sync, and one person whose Google access lapsed.

const WEEKS_BACK = 6;
const WEEKS_AHEAD = 10;
const WEEKDAYS = [0, 1, 2, 3, 4];

type Ctx = { monday: string; tz: string };
type Gen = (ctx: Ctx) => Busy[];

function at(ctx: Ctx, offset: number, hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return zonedTime(addDays(ctx.monday, offset), h + m / 60, ctx.tz);
}

/** From–to on a day; an end at or before the start runs past midnight. */
function span(ctx: Ctx, offset: number, from: string, to: string): [number, number] {
  return [at(ctx, offset, from), at(ctx, to <= from ? offset + 1 : offset, to)];
}

/** Title, visibility and details of a made-up event. */
type Meta = { title?: string; private?: boolean; details?: Busy["details"] };

/** Weekly on `days` (0 = Monday); `except` skips occurrences, `moved` reschedules one. */
function weekly(
  days: number[],
  from: string,
  to: string,
  opts: Meta & { except?: number[]; moved?: { from: number; to: [number, string, string] } } = {},
): Gen {
  return (ctx) => {
    const out: Busy[] = [];
    for (let w = -WEEKS_BACK; w <= WEEKS_AHEAD; w++) {
      for (const d of days) {
        const offset = w * 7 + d;
        if (opts.except?.includes(offset)) continue;
        const [start, end] =
          opts.moved?.from === offset ? span(ctx, ...opts.moved.to) : span(ctx, offset, from, to);
        out.push({ start, end, title: opts.title, private: opts.private, details: opts.details });
      }
    }
    return out;
  };
}

function once(offset: number, from: string, to: string, opts: Meta & { tentative?: boolean } = {}): Gen {
  return (ctx) => {
    const [start, end] = span(ctx, offset, from, to);
    return [{ start, end, ...opts }];
  };
}

function allDay(offset: number, days = 1, opts: Meta = {}): Gen {
  return (ctx) => [
    {
      start: dayStart(addDays(ctx.monday, offset), ctx.tz),
      end: dayStart(addDays(ctx.monday, offset + days), ctx.tz),
      allDay: true,
      ...opts,
    },
  ];
}

type DemoCalendar = {
  id: string;
  summary: string;
  label: string;
  events: Gen[];
  access?: "events" | "freebusy";
  included?: boolean;
  error?: string;
};

type DemoPerson = {
  id: string;
  name: string;
  team: string | null;
  timezone: string;
  /** Preset colour name; by default the next one in order. */
  color?: (typeof PRESET_COLORS)[number]["name"];
  tokenError?: string;
  calendars: DemoCalendar[];
};

const domain = "orbit.example";
const work = (id: string, events: Gen[]): DemoCalendar => ({
  id: `${id}@${domain}`,
  summary: `${id}@${domain}`,
  label: "Orbit",
  events,
});

const PEOPLE: DemoPerson[] = [
  {
    id: "ahmet",
    name: "Ahmet Yılmaz",
    team: "Design",
    timezone: "Europe/Istanbul",
    calendars: [
      work("ahmet", [
        weekly(WEEKDAYS, "10:00", "12:30", { title: "Design sprint" }),
        once(3, "15:00", "16:30", {
          title: "Client review: Acme",
          details: {
            location: "Acme HQ, 185 Büyükdere Avenue, Levent, Istanbul",
            description: "Walk Acme through the new onboarding screens.\n\nPrototype: https://www.figma.com/proto/demo-onboarding\nBring the printed style guide.",
          },
        }),
        once(1, "16:30", "17:30", { title: "Portfolio chat", tentative: true }),
      ]),
      {
        id: "ahmet.freelance@gmail.example",
        summary: "Freelance work",
        label: "Freelance",
        // A personal calendar: only Ahmet sees these titles.
        events: [weekly([0, 2], "14:00", "16:00", { title: "Logo project" }), weekly([5], "11:00", "15:00", { title: "Wedding photos" })],
      },
      // Subscribed but not his time: not counted.
      { id: "tr.turkish#holiday@group.v.calendar.google.com", summary: "Holidays in Türkiye", label: "Holidays", events: [], included: false },
    ],
  },
  {
    id: "elif",
    name: "Elif Kaya",
    team: "Engineering",
    timezone: "Europe/London",
    calendars: [
      work("elif", [
        weekly(WEEKDAYS, "09:00", "11:00", { title: "Platform work" }),
        weekly(WEEKDAYS, "13:00", "14:00", {
          title: "Team sync",
          details: {
            meetLink: "https://meet.google.com/abc-defg-hij",
            description: "Daily sync for the platform team.\nNotes: https://docs.google.com/document/d/demo-team-sync",
          },
        }),
        allDay(10, 2, { title: "Conference in Lisbon" }),
        // Private on the company calendar: colleagues only see the label.
        once(2, "15:00", "16:00", { title: "Doctor's appointment", private: true }),
      ]),
      {
        id: "elif.tutoring@gmail.example",
        summary: "Tutoring",
        label: "Tutoring",
        events: [
          weekly([1, 3], "18:00", "20:00", { title: "Maths tutoring" }),
          once(5, "10:00", "12:00", { title: "Trial lesson", tentative: true }),
        ],
      },
    ],
  },
  {
    id: "mert",
    name: "Mert Demir",
    team: "Engineering",
    timezone: "Europe/Berlin",
    calendars: [
      work("mert", [
        weekly([0, 2, 4], "09:00", "11:30", { title: "Standup & planning", moved: { from: 4, to: [4, "14:00", "16:30"] } }),
        weekly([1, 3], "13:00", "15:00", {
          title: "Architecture review",
          details: { description: "Join on Zoom: https://zoom.us/j/1234567890\nAgenda: sync service, SQLite backups." },
        }),
      ]),
      // Shared as "See only free/busy".
      {
        id: "mert.school@gmail.example",
        summary: "School",
        label: "School",
        access: "freebusy",
        // Free/busy only: Google gives no titles, even to Mert.
        events: [weekly([2], "16:00", "17:00"), once(3, "18:00", "19:30")],
      },
      // Someone else's calendar he subscribed to: not counted.
      { id: `zeynep@${domain}`, summary: "Zeynep Şahin", label: "Zeynep", events: [], included: false },
    ],
  },
  {
    id: "zeynep",
    name: "Zeynep Şahin",
    team: "Product",
    timezone: "Europe/Istanbul",
    calendars: [
      work("zeynep", [weekly([0, 1, 2, 3], "10:00", "13:00", { title: "Roadmap planning", except: [2] })]),
      {
        id: "zeynep.cafe@gmail.example",
        summary: "Café shifts",
        label: "Café",
        events: [weekly([1, 3], "18:30", "22:30", { title: "Evening shift" }), weekly([6], "12:00", "20:00", { title: "Weekend shift" })],
      },
    ],
  },
  {
    id: "can",
    name: "Can Öztürk",
    team: "Design",
    timezone: "Europe/London",
    calendars: [
      work("can", [
        weekly([0, 1, 2, 3], "10:00", "12:00", { title: "Design critique", details: { location: "Studio, 2nd floor" } }),
        allDay(4, 1, { title: "Day off" }),
      ]),
      {
        id: "can.nights@gmail.example",
        summary: "Night shift",
        label: "Night shift",
        events: [weekly([4, 5], "20:00", "02:00", { title: "Bar shift" })],
      },
      {
        id: "can.band@gmail.example",
        summary: "Band rehearsals",
        label: "Band",
        events: [],
        error: "Calendar not found: it may no longer be shared with this account",
      },
    ],
  },
  {
    id: "deniz",
    name: "Deniz Aydın",
    team: null,
    timezone: "Europe/Istanbul",
    color: "cyan",
    tokenError: "Google access expired or was revoked",
    calendars: [
      work("deniz", [weekly(WEEKDAYS, "07:00", "09:30", { title: "Early support shift" }), once(7, "09:00", "19:00", { title: "Offsite workshop" })]),
    ],
  },
];

/** This week's Monday in `tz`, or next week's at the weekend. */
function demoMonday(tz: string): string {
  const today = dayKeyOf(Date.now(), tz);
  const wd = weekday(today);
  return addDays(today, wd === 6 ? 2 : wd === 0 ? 1 : 1 - wd);
}

/**
 * Replaces everything in the database with the demo people. Returns false,
 * touching nothing, if real people have signed in to this database.
 */
export function seedDemo(config: AppConfig): boolean {
  if (listUsers().some((u) => u.google_sub)) return false;
  const monday = demoMonday(config.timezone);
  const now = Date.now();
  transaction(() => {
    resetAll();
    const conn = db();
    const addUser = conn.prepare(
      `INSERT INTO users (id, google_sub, email, name, team, timezone, color, refresh_token, calendar_access, token_error, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    );
    const addCal = conn.prepare(
      `INSERT INTO calendars (user_id, calendar_id, summary, label, access, is_primary, included, position, last_success, last_attempt, error, events)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const addBusy = conn.prepare(
      `INSERT INTO busy (user_id, calendar_id, start_ms, end_ms, tentative, all_day, title, private, ref, description, location, meet_link, html_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    PEOPLE.forEach((p, pi) => {
      const team = p.team && config.teams.includes(p.team) ? p.team : null;
      const color = (PRESET_COLORS.find((c) => c.name === p.color) ?? PRESET_COLORS[pi]).hex;
      addUser.run(p.id, `${p.id}@${domain}`, p.name, team, p.timezone, color, p.tokenError ?? null, now + pi);
      p.calendars.forEach((c, ci) => {
        const busy = c.events.flatMap((gen) => gen({ monday, tz: p.timezone }));
        addCal.run(
          p.id,
          c.id,
          c.summary,
          c.label,
          c.access ?? "events",
          ci === 0 ? 1 : 0,
          c.included === false ? 0 : 1,
          ci,
          c.error ? null : now,
          now,
          c.error ?? null,
          busy.length,
        );
        for (const b of busy) {
          addBusy.run(
            p.id,
            c.id,
            b.start,
            b.end,
            b.tentative ? 1 : 0,
            b.allDay ? 1 : 0,
            b.title ?? null,
            b.private ? 1 : 0,
            eventRef(p.id, c.id, `${b.start}-${b.end}`),
            b.details?.description ?? null,
            b.details?.location ?? null,
            b.details?.meetLink ?? null,
            b.details?.htmlLink ?? null,
          );
        }
      });
    });
  });
  return true;
}
