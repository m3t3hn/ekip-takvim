import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  calendarServer,
  calendarText,
  googleRefusesEveryToken,
  routePublicAddress,
  utcDay,
  utcMidnight,
  vevent,
  type CalendarServer,
} from "./link-helpers";

// Calendar links, criteria 5 and 6, and the reading side of 11: links are read
// by syncOne and the sync round apart from Google, in the person's zone, with
// conditional requests within a day of the last full read and while the sync
// window is the one that read covered. Calendars are served from 127.0.0.1
// (CALENDAR_LINKS=private); Google's token endpoint refuses every refresh
// token, so nothing here reaches the network.
const SECRET = "s".repeat(40);
const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = SECRET;
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
delete process.env.DEMO_MODE;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const db = await import("@/lib/server/db");
const sync = await import("@/lib/server/sync");
const secrets = await import("@/lib/server/secrets");
const { icsBusy } = await import("@/lib/server/ics");

type Row = Record<string, unknown>;
type Block = { start: number; end: number; title: string | null; allDay: boolean };

// Days from today (UTC): the window is 42 days back to 30 ahead (horizon_days).
const D1 = utcDay(2);
const D2 = utcDay(3);
const D3 = utcDay(4);
const D3_NEXT = utcDay(5);
const FEED = calendarText(
  vevent("standup@side", "Side-job standup", `DTSTART:${D1}T100000Z`, `DTEND:${D1}T103000Z`),
  // No zone: read in the person's.
  vevent("review@side", "Floating review", `DTSTART:${D2}T100000`, `DTEND:${D2}T110000`),
  vevent("away@side", "Away", `DTSTART;VALUE=DATE:${D3}`, `DTEND;VALUE=DATE:${D3_NEXT}`),
  vevent("far@side", "Beyond the horizon", `DTSTART:${utcDay(45)}T100000Z`, `DTEND:${utcDay(45)}T110000Z`),
  vevent("past@side", "Before the window", `DTSTART:${utcDay(-50)}T100000Z`, `DTEND:${utcDay(-50)}T110000Z`),
);
const FEED_V2 = FEED.replace(
  "END:VCALENDAR",
  vevent("added@side", "Added later", `DTSTART:${D1}T150000Z`, `DTEND:${D1}T160000Z`).join("\r\n") + "\r\nEND:VCALENDAR",
);

/** The blocks FEED gives someone in Europe/Istanbul (UTC+3, no daylight saving time), worked out by hand. */
const ISTANBUL: Block[] = [
  { start: utcMidnight(D1) + 10 * HOUR_MS, end: utcMidnight(D1) + 10.5 * HOUR_MS, title: "Side-job standup", allDay: false },
  { start: utcMidnight(D2) + 7 * HOUR_MS, end: utcMidnight(D2) + 8 * HOUR_MS, title: "Floating review", allDay: false },
  { start: utcMidnight(D3) - 3 * HOUR_MS, end: utcMidnight(D3_NEXT) - 3 * HOUR_MS, title: "Away", allDay: true },
];
/** And someone in Asia/Tokyo (UTC+9, no daylight saving time). */
const TOKYO: Block[] = [
  ISTANBUL[0],
  { start: utcMidnight(D2) + 1 * HOUR_MS, end: utcMidnight(D2) + 2 * HOUR_MS, title: "Floating review", allDay: false },
  { start: utcMidnight(D3) - 9 * HOUR_MS, end: utcMidnight(D3_NEXT) - 9 * HOUR_MS, title: "Away", allDay: true },
];

let server: CalendarServer;
let googleCalls: string[] = [];

beforeAll(async () => {
  server = await calendarServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  db.resetAll();
  server.hits.length = 0;
  googleCalls = googleRefusesEveryToken();
  // Every path answers FEED unless a test says otherwise.
  server.handle((_req, res) => {
    res.setHeader("Content-Type", "text/calendar");
    res.end(FEED);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.CONFIG_YAML = CONFIG;
  sync.getConfig();
  process.env.CALENDAR_LINKS = "private";
  process.env.SESSION_SECRET = SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.DEMO_MODE;
});

let n = 0;
function person(name: string, timezone: string, google: "none" | "revoked" = "none") {
  n++;
  const user = db.upsertGoogleUser({
    sub: `g-${n}`,
    email: `p${n}@example.com`,
    name,
    timezone,
    refreshToken: google === "revoked" ? secrets.encrypt(`1//refresh-${n}`) : null,
    calendarAccess: true,
  }).user;
  if (google === "revoked") db.setTokenError(user.id, "Google access expired or was revoked");
  return user;
}

const calendar = (userId: string, id: string) => db.listCalendars(userId).find((c) => c.calendar_id === id)!;
const stored = (userId: string, id: string) =>
  db.db().prepare("SELECT * FROM busy WHERE user_id = ? AND calendar_id = ? ORDER BY start_ms, rowid").all(userId, id) as Row[];
const blocks = (rows: Row[]): Block[] =>
  rows.map((r) => ({ start: Number(r.start_ms), end: Number(r.end_ms), title: (r.title as string | null) ?? null, allDay: !!r.all_day }));
/** What icsBusy makes of `text` over the sync window in `timezone`. */
function expected(text: string, timezone: string): Block[] {
  const config = sync.getConfig()!;
  return icsBusy(text, { ...sync.syncWindow(config), timezone }).busy.map((b) => ({
    start: b.start,
    end: b.end,
    title: b.title ?? null,
    allDay: !!b.allDay,
  }));
}
const hitsOn = (path: string) => server.hits.filter((h) => h.url === path);

describe("reading calendar links (criterion 6)", () => {
  it("syncOne reads a link of someone without a refresh token over the sync window, in their zone, and records a success", async () => {
    const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
    const path = "/feeds/no-token-7Hq2/basic.ics?key=k1";
    const id = db.addLinkCalendar(ahmet.id, server.origin + path, "Side job");
    const started = Date.now();
    await sync.syncOne(ahmet.id);

    expect(hitsOn(path)).toHaveLength(1);
    expect(blocks(stored(ahmet.id, id))).toEqual(ISTANBUL);
    expect(blocks(stored(ahmet.id, id))).toEqual(expected(FEED, "Europe/Istanbul"));
    const cal = calendar(ahmet.id, id);
    expect(cal.error).toBeNull();
    expect(cal.last_success).toBeGreaterThanOrEqual(started);
    expect(googleCalls).toEqual([]);
  });

  it("syncOne reads it when the person's Google access is gone, beside their Google calendars", async () => {
    const elif = person("Elif Kaya", "Europe/Istanbul", "revoked");
    db.syncCalendarList(elif.id, [{ id: "elif@example.com", summary: "elif@example.com", access: "events", primary: true }]);
    const path = "/feeds/revoked-p0Z/basic.ics";
    const id = db.addLinkCalendar(elif.id, server.origin + path, "Side job");
    await sync.syncOne(elif.id);

    expect(hitsOn(path)).toHaveLength(1);
    expect(blocks(stored(elif.id, id))).toEqual(ISTANBUL);
    expect(calendar(elif.id, id)).toMatchObject({ error: null });
    expect(calendar(elif.id, id).last_success).not.toBeNull();
    // Google was asked and refused: their access is still gone, their Google calendar unread.
    expect(googleCalls.some((u) => u.startsWith("https://oauth2.googleapis.com/token"))).toBe(true);
    expect(db.getUser(elif.id)!.token_error).not.toBeNull();
    expect(calendar(elif.id, "elif@example.com").last_success).toBeNull();
  });

  it("reads the same link in each person's own zone", async () => {
    const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
    const kenji = person("Kenji Sato", "Asia/Tokyo");
    const path = "/feeds/shared-9cXv/basic.ics";
    const a = db.addLinkCalendar(ahmet.id, server.origin + path, "Club");
    const k = db.addLinkCalendar(kenji.id, server.origin + path, "Club");
    await sync.syncOne(ahmet.id);
    await sync.syncOne(kenji.id);
    expect(blocks(stored(ahmet.id, a))).toEqual(ISTANBUL);
    expect(blocks(stored(kenji.id, k))).toEqual(TOKYO);
    expect(blocks(stored(kenji.id, k))).toEqual(expected(FEED, "Asia/Tokyo"));
  });

  it("the sync round reads every counted link calendar, whatever the owner's Google access", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
    const elif = person("Elif Kaya", "Europe/Istanbul", "revoked");
    const kenji = person("Kenji Sato", "Asia/Tokyo");
    const links = [
      { user: ahmet.id, path: "/round/a-1.ics", zone: ISTANBUL },
      { user: ahmet.id, path: "/round/a-2.ics?x=1", zone: ISTANBUL },
      { user: elif.id, path: "/round/e-1.ics", zone: ISTANBUL },
      { user: kenji.id, path: "/round/k-1.ics", zone: TOKYO },
    ].map((l, i) => ({ ...l, id: db.addLinkCalendar(l.user, server.origin + l.path, `Link ${i}`) }));

    await sync.syncNow();

    for (const l of links) {
      expect(hitsOn(l.path), l.path).toHaveLength(1);
      expect(blocks(stored(l.user, l.id)), l.path).toEqual(l.zone);
      expect(calendar(l.user, l.id).error, l.path).toBeNull();
      expect(calendar(l.user, l.id).last_success, l.path).not.toBeNull();
    }
  });

  it("goes to private addresses only with CALENDAR_LINKS=private", async () => {
    const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
    const path = "/feeds/private-only-Rt5.ics";
    const id = db.addLinkCalendar(ahmet.id, server.origin + path, "Home server");

    for (const setting of ["on", undefined]) {
      if (setting) process.env.CALENDAR_LINKS = setting;
      else delete process.env.CALENDAR_LINKS;
      await sync.syncOne(ahmet.id);
      expect(hitsOn(path), String(setting)).toEqual([]);
      expect(calendar(ahmet.id, id).error, String(setting)).toEqual(expect.any(String));
      expect(stored(ahmet.id, id)).toEqual([]);
    }

    process.env.CALENDAR_LINKS = "private";
    await sync.syncOne(ahmet.id);
    expect(hitsOn(path)).toHaveLength(1);
    expect(calendar(ahmet.id, id).error).toBeNull();
    expect(blocks(stored(ahmet.id, id))).toEqual(ISTANBUL);
  });

  it("asks what changed within 24 hours of the last full read while the window holds, keeps the blocks on 304, and reads in full from 24 hours", async () => {
    const deniz = person("Deniz Aydın", "Europe/Istanbul");
    const path = "/feeds/versioned-Kq8/basic.ics";
    const id = db.addLinkCalendar(deniz.id, server.origin + path, "Versioned");
    let current = { etag: '"v1"', lastModified: "Wed, 11 Nov 2026 10:00:00 GMT", text: FEED };
    let failing = false;
    server.handle((req, res) => {
      if (failing) {
        res.statusCode = 503;
        return void res.end("try later");
      }
      if (req.headers["if-none-match"] === current.etag) {
        res.statusCode = 304;
        return void res.end();
      }
      res.setHeader("ETag", current.etag);
      res.setHeader("Last-Modified", current.lastModified);
      res.setHeader("Content-Type", "text/calendar");
      res.end(current.text);
    });
    const conditional = (i: number) => {
      const h = hitsOn(path)[i].headers;
      return { etag: h["if-none-match"], since: h["if-modified-since"] };
    };

    // The start of today in the team's zone (UTC), so the window holds until t0 + 24 h.
    // The 24-hour rule on its own, the window holding, is checked on a 25-hour day further down.
    const t0 = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    await sync.syncOne(deniz.id);
    expect(conditional(0)).toEqual({ etag: undefined, since: undefined });
    const first = stored(deniz.id, id);
    expect(blocks(first)).toEqual(ISTANBUL);
    expect(calendar(deniz.id, id).last_success).toBe(t0);

    // An hour later the server fails: the error is recorded, the blocks stay.
    vi.setSystemTime(t0 + HOUR_MS);
    failing = true;
    await sync.syncOne(deniz.id);
    expect(conditional(1)).toEqual({ etag: '"v1"', since: "Wed, 11 Nov 2026 10:00:00 GMT" });
    expect(calendar(deniz.id, id).error).toEqual(expect.any(String));
    expect(calendar(deniz.id, id).last_success).toBe(t0);
    expect(stored(deniz.id, id)).toEqual(first);

    // Just under a day after the full read, the same day: still conditional; 304 keeps the blocks and is a success.
    vi.setSystemTime(t0 + DAY_MS - 1);
    failing = false;
    await sync.syncOne(deniz.id);
    expect(conditional(2)).toEqual({ etag: '"v1"', since: "Wed, 11 Nov 2026 10:00:00 GMT" });
    expect(stored(deniz.id, id)).toEqual(first);
    expect(calendar(deniz.id, id)).toMatchObject({ error: null, last_success: t0 + DAY_MS - 1 });

    // Exactly a day after it: a full read, without either header.
    vi.setSystemTime(t0 + DAY_MS);
    current = { etag: '"v2"', lastModified: "Fri, 13 Nov 2026 08:30:00 GMT", text: FEED_V2 };
    await sync.syncOne(deniz.id);
    expect(hitsOn(path)).toHaveLength(4);
    expect(conditional(3)).toEqual({ etag: undefined, since: undefined });
    expect(blocks(stored(deniz.id, id))).toEqual(expected(FEED_V2, "Europe/Istanbul"));
    expect(blocks(stored(deniz.id, id)).map((b) => b.title)).toContain("Added later");

    // And conditional again, on the new version.
    vi.setSystemTime(t0 + DAY_MS + 1000);
    await sync.syncOne(deniz.id);
    expect(conditional(4)).toEqual({ etag: '"v2"', since: "Fri, 13 Nov 2026 08:30:00 GMT" });
  });

  it("reads in the person's new zone after they change it, even where the server would answer 304", async () => {
    const deniz = person("Deniz Aydın", "Europe/Istanbul");
    const path = "/feeds/moving-Vb3/basic.ics";
    const id = db.addLinkCalendar(deniz.id, server.origin + path, "Moving");
    server.handle((req, res) => {
      if (req.headers["if-none-match"] === '"same"') {
        res.statusCode = 304;
        return void res.end();
      }
      res.setHeader("ETag", '"same"');
      res.end(FEED);
    });
    await sync.syncOne(deniz.id);
    expect(blocks(stored(deniz.id, id))).toEqual(ISTANBUL);
    db.updateUser(deniz.id, { timezone: "Asia/Tokyo" });
    await sync.syncOne(deniz.id);
    expect(blocks(stored(deniz.id, id))).toEqual(TOKYO);
  });

  it("records a failure on the calendar and keeps its stored blocks", async () => {
    const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
    const path = "/feeds/flaky-Mn4/basic.ics";
    const id = db.addLinkCalendar(ahmet.id, server.origin + path, "Flaky");
    await sync.syncOne(ahmet.id);
    const kept = stored(ahmet.id, id);
    const success = calendar(ahmet.id, id).last_success;
    expect(kept).toHaveLength(ISTANBUL.length);

    for (const [status, body] of [[500, "boom"], [404, "gone"], [200, "<html>not a calendar</html>"]] as const) {
      server.handle((_req, res: ServerResponse) => {
        res.statusCode = status;
        res.end(body);
      });
      await sync.syncOne(ahmet.id);
      expect(calendar(ahmet.id, id).error, `${status}`).toEqual(expect.any(String));
      expect(calendar(ahmet.id, id).last_success, `${status}`).toBe(success);
      expect(stored(ahmet.id, id), `${status}`).toEqual(kept);
    }
  });

  it("says to add a link again when it can't be decrypted any more", async () => {
    const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
    const path = "/feeds/sealed-Lp7/basic.ics";
    const id = db.addLinkCalendar(ahmet.id, server.origin + path, "Sealed");
    process.env.SESSION_SECRET = "a different secret, at least 32 characters long";
    await sync.syncOne(ahmet.id);
    process.env.SESSION_SECRET = SECRET;

    const error = calendar(ahmet.id, id).error;
    expect(error).toMatch(/\badd\b/i);
    expect(error).toMatch(/\bagain\b/i);
    expect(hitsOn(path)).toEqual([]);
  });
});

describe("a link's stored blocks cover the sync window as it is now (criterion 6, fix round 1)", () => {
  // One event every day at 20:00 UTC, so every day of any window has a block,
  // and windows that differ by a few hours hold different blocks.
  const DAILY = calendarText(
    vevent("daily@side", "Evening check-in", "DTSTART:20260101T200000Z", "DTEND:20260101T203000Z", ["RRULE:FREQ=DAILY"]),
  );
  const ETAG = '"daily-1"';
  const LAST_MODIFIED = "Thu, 12 Nov 2026 09:00:00 GMT";
  const FULL = { etag: undefined, since: undefined };
  const CONDITIONAL = { etag: ETAG, since: LAST_MODIFIED };
  const at = (iso: string) => vi.setSystemTime(Date.parse(iso));
  const plusDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

  /** The server answers 304 to a request naming its version, so only a full read brings in other days. */
  function serveDaily(beforeAnswer?: () => void) {
    server.handle((req, res) => {
      beforeAnswer?.();
      if (req.headers["if-none-match"] === ETAG) {
        res.statusCode = 304;
        return void res.end();
      }
      res.setHeader("ETag", ETAG);
      res.setHeader("Last-Modified", LAST_MODIFIED);
      res.setHeader("Content-Type", "text/calendar");
      res.end(DAILY);
    });
  }
  /** For each request to `path`, what it asked with. */
  const asked = (path: string) => hitsOn(path).map((h) => ({ etag: h.headers["if-none-match"], since: h.headers["if-modified-since"] }));

  /** Another team config. An inline config is read again when its length changes; the caller checks it took. */
  function teamConfig(yaml: string) {
    process.env.CONFIG_YAML = yaml;
    return sync.getConfig()!;
  }

  /** The first and last days availability says are covered, in the team's zone, and what the owner shows on them. */
  function coveredEdges(userId: string) {
    const tz = sync.getConfig()!.timezone;
    const today = new Date().toISOString().slice(0, 10);
    const { coverage } = sync.getAvailability(today, 1, tz, userId)!;
    const on = (day: string) => sync.getAvailability(day, 1, tz, userId)!.people.find((p) => p.id === userId)!;
    const first = on(coverage.from);
    const last = on(coverage.to);
    return { from: coverage.from, fromBusy: first.busy.length, to: coverage.to, toBusy: last.busy.length, data: last.data, stale: last.stale };
  }

  it("reads in full once a new day starts in the team's zone, though the last full read is two hours old; then asks again that day", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    vi.useFakeTimers({ toFake: ["Date"] });
    serveDaily();
    at("2026-11-13T23:00:00Z");
    const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
    const path = "/window/next-day-Wd1.ics";
    const id = db.addLinkCalendar(ahmet.id, server.origin + path, "Daily");
    await sync.syncOne(ahmet.id);
    const before = coveredEdges(ahmet.id);
    expect(before).toMatchObject({ to: "2026-12-13", toBusy: 1, data: "ok" });

    // 01:00 the next day in UTC, the team's zone: the round reads it in full.
    at("2026-11-14T01:00:00Z");
    await sync.syncNow();
    expect(asked(path)).toEqual([FULL, FULL]);
    expect(blocks(stored(ahmet.id, id))).toEqual(expected(DAILY, "Europe/Istanbul"));
    expect(coveredEdges(ahmet.id)).toMatchObject({ to: plusDays(before.to, 1), toBusy: 1, data: "ok", stale: false });

    // Later that day the window holds: syncOne asks what changed, and the 304 keeps the blocks.
    const kept = stored(ahmet.id, id);
    at("2026-11-14T05:00:00Z");
    await sync.syncOne(ahmet.id);
    expect(asked(path)).toEqual([FULL, FULL, CONDITIONAL]);
    expect(stored(ahmet.id, id)).toEqual(kept);
    expect(calendar(ahmet.id, id)).toMatchObject({ error: null, last_success: Date.parse("2026-11-14T05:00:00Z") });
    expect(coveredEdges(ahmet.id)).toMatchObject({ to: plusDays(before.to, 1), toBusy: 1, data: "ok", stale: false });
  });

  it("reads in full after horizon_days is raised or lowered, then asks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serveDaily();
    at("2026-11-13T10:00:00Z");
    const elif = person("Elif Kaya", "Europe/Istanbul");
    const path = "/window/horizon-Hz2.ics";
    const id = db.addLinkCalendar(elif.id, server.origin + path, "Daily");
    await sync.syncOne(elif.id);
    const before = coveredEdges(elif.id);
    expect(before).toMatchObject({ to: "2026-12-13", toBusy: 1 });

    expect(teamConfig("timezone: UTC\nhorizon_days: 120\n")).toMatchObject({ timezone: "UTC", horizonDays: 120 });
    at("2026-11-13T11:00:00Z");
    await sync.syncOne(elif.id);
    expect(asked(path)).toEqual([FULL, FULL]);
    expect(blocks(stored(elif.id, id))).toEqual(expected(DAILY, "Europe/Istanbul"));
    expect(coveredEdges(elif.id)).toMatchObject({ to: plusDays(before.to, 90), toBusy: 1, data: "ok", stale: false });

    at("2026-11-13T12:00:00Z");
    await sync.syncOne(elif.id);
    expect(asked(path)).toEqual([FULL, FULL, CONDITIONAL]);

    // Lowered: the days past the new horizon are dropped.
    expect(teamConfig("timezone: UTC\nhorizon_days: 7\n")).toMatchObject({ timezone: "UTC", horizonDays: 7 });
    at("2026-11-13T13:00:00Z");
    await sync.syncOne(elif.id);
    expect(asked(path)).toEqual([FULL, FULL, CONDITIONAL, FULL]);
    expect(blocks(stored(elif.id, id))).toEqual(expected(DAILY, "Europe/Istanbul"));
    expect(coveredEdges(elif.id)).toMatchObject({ to: plusDays(before.to, -23), toBusy: 1 });

    at("2026-11-13T14:00:00Z");
    await sync.syncOne(elif.id);
    expect(asked(path)).toEqual([FULL, FULL, CONDITIONAL, FULL, CONDITIONAL]);
  });

  it("reads in full after the team's zone changes, on the same date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serveDaily();
    at("2026-11-13T10:00:00Z");
    const kenji = person("Kenji Sato", "Asia/Tokyo");
    const path = "/window/team-zone-Tz3.ics";
    const id = db.addLinkCalendar(kenji.id, server.origin + path, "Daily");
    await sync.syncOne(kenji.id);

    // 20:00 in Tokyo, still the 13th there: the window starts and ends nine hours earlier.
    expect(teamConfig("timezone: Asia/Tokyo\nhorizon_days: 30\n")).toMatchObject({ timezone: "Asia/Tokyo", horizonDays: 30 });
    at("2026-11-13T11:00:00Z");
    await sync.syncOne(kenji.id);
    expect(asked(path)).toEqual([FULL, FULL]);
    expect(blocks(stored(kenji.id, id))).toEqual(expected(DAILY, "Asia/Tokyo"));
    // The first covered day in Tokyo starts at 15:00 UTC the day before: its 20:00 UTC block is new.
    expect(coveredEdges(kenji.id)).toMatchObject({ from: "2026-10-02", fromBusy: 1, toBusy: 1, data: "ok", stale: false });

    at("2026-11-13T12:00:00Z");
    await sync.syncOne(kenji.id);
    expect(asked(path)).toEqual([FULL, FULL, CONDITIONAL]);
  });

  it("reads in full once the last full read is 24 hours old though the window holds (a 25-hour day), and once the day turns though it's an hour old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serveDaily();
    expect(teamConfig("timezone: Europe/Berlin\nhorizon_days: 30\n")).toMatchObject({ timezone: "Europe/Berlin", horizonDays: 30 });
    // 25 October 2026 has 25 hours in Berlin (clocks go back at 03:00): 22:00 UTC on the 24th to 23:00 UTC on the 25th.
    const t0 = Date.parse("2026-10-24T22:00:00Z");
    vi.setSystemTime(t0);
    const deniz = person("Deniz Aydın", "Europe/Istanbul");
    const path = "/window/long-day-Ld4.ics";
    const id = db.addLinkCalendar(deniz.id, server.origin + path, "Daily");
    await sync.syncOne(deniz.id);
    const window = sync.syncWindow(sync.getConfig()!);
    const first = stored(deniz.id, id);

    vi.setSystemTime(t0 + DAY_MS - 1);
    await sync.syncOne(deniz.id);
    expect(asked(path)).toEqual([FULL, CONDITIONAL]);
    expect(stored(deniz.id, id)).toEqual(first);
    expect(calendar(deniz.id, id)).toMatchObject({ error: null, last_success: t0 + DAY_MS - 1 });

    // 23:00 in Berlin, still the 25th: the window holds, but the last full read is a day old.
    vi.setSystemTime(t0 + DAY_MS);
    expect(sync.syncWindow(sync.getConfig()!)).toEqual(window);
    await sync.syncOne(deniz.id);
    expect(asked(path)).toEqual([FULL, CONDITIONAL, FULL]);

    vi.setSystemTime(t0 + DAY_MS + 1000);
    await sync.syncOne(deniz.id);
    expect(asked(path)).toEqual([FULL, CONDITIONAL, FULL, CONDITIONAL]);

    // Midnight in Berlin, the 26th: another window, though the last full read is an hour old.
    vi.setSystemTime(t0 + DAY_MS + HOUR_MS);
    expect(sync.syncWindow(sync.getConfig()!)).not.toEqual(window);
    await sync.syncOne(deniz.id);
    expect(asked(path)).toEqual([FULL, CONDITIONAL, FULL, CONDITIONAL, FULL]);
    expect(blocks(stored(deniz.id, id))).toEqual(expected(DAILY, "Europe/Istanbul"));
  });

  it("reads in full a link whose blocks have no window on record, like a row kept from before windows were recorded", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    serveDaily();
    at("2026-11-13T10:00:00Z");
    const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
    const path = "/window/no-window-Nw5.ics";
    const id = db.addLinkCalendar(ahmet.id, server.origin + path, "Daily");
    await sync.syncOne(ahmet.id);
    db.db().prepare("UPDATE calendars SET link_window_from = NULL, link_window_to = NULL WHERE calendar_id = ?").run(id);

    at("2026-11-13T11:00:00Z");
    await sync.syncOne(ahmet.id);
    at("2026-11-13T12:00:00Z");
    await sync.syncOne(ahmet.id);
    expect(asked(path)).toEqual([FULL, FULL, CONDITIONAL]);
  });

  it("covers the new day by the next sync after a read whose answer came after midnight, read in full or answered 304", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // While set, the server lets midnight pass before it answers.
    let acrossMidnight = false;
    serveDaily(() => {
      if (!acrossMidnight) return;
      acrossMidnight = false;
      at("2026-11-14T00:01:00Z");
    });
    at("2026-11-13T22:00:00Z");
    const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
    const elif = person("Elif Kaya", "Europe/Istanbul");
    const fullPath = "/window/across-full-Af6.ics";
    const unchangedPath = "/window/across-304-Au6.ics";
    const a = db.addLinkCalendar(ahmet.id, server.origin + fullPath, "Daily");
    const e = db.addLinkCalendar(elif.id, server.origin + unchangedPath, "Daily");
    await sync.syncOne(elif.id);

    // 23:59: Elif's link is asked what changed, Ahmet's is read in full; both answers come at 00:01.
    at("2026-11-13T23:59:00Z");
    acrossMidnight = true;
    await sync.syncOne(elif.id);
    at("2026-11-13T23:59:00Z");
    acrossMidnight = true;
    await sync.syncOne(ahmet.id);
    expect(asked(unchangedPath)).toEqual([FULL, CONDITIONAL]);
    expect(asked(fullPath)).toEqual([FULL]);

    at("2026-11-14T01:00:00Z");
    await sync.syncOne(elif.id);
    await sync.syncOne(ahmet.id);
    for (const [userId, id] of [
      [ahmet.id, a],
      [elif.id, e],
    ]) {
      expect(coveredEdges(userId), userId).toMatchObject({ to: "2026-12-14", toBusy: 1, data: "ok", stale: false });
      expect(blocks(stored(userId, id)), userId).toEqual(expected(DAILY, "Europe/Istanbul"));
    }
  });
});

describe("a slow calendar link (dispatch point 2: it holds up no one's Google sync)", () => {
  it("doesn't hold up Google calendars, in the round or in syncOne", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    // Google answers for one refresh token: one primary calendar with one event.
    const goodToken = "1//good-refresh";
    const start = utcMidnight(D1) + 13 * HOUR_MS;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new URLSearchParams(String(init?.body)).get("refresh_token") === goodToken
          ? json({ access_token: "access", expires_in: 3600, scope: "openid https://www.googleapis.com/auth/calendar.readonly" })
          : json({ error: "invalid_grant" }, 400);
      }
      if (url.startsWith("https://www.googleapis.com/calendar/v3/users/me/calendarList")) {
        return json({ items: [{ id: "gamze@example.com", summary: "gamze@example.com", primary: true, accessRole: "owner" }] });
      }
      if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/")) {
        return json({ items: [{ id: "g1", summary: "Planning", status: "confirmed", start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(start + HOUR_MS).toISOString() } }] });
      }
      throw new TypeError("test: no network");
    });
    const held: ServerResponse[] = [];
    server.handle((_req, res) => void held.push(res));
    const release = () => {
      for (const res of held.splice(0)) res.end(FEED);
    };

    // Six people with a slow link each, then Gamze, whose Google works and who has one too.
    const slow = Array.from({ length: 6 }, (_, i) => {
      const p = person(`Slow ${i}`, "Europe/Istanbul");
      return { user: p.id, id: db.addLinkCalendar(p.id, `${server.origin}/slow/${i}.ics`, "Slow") };
    });
    const gamze = db.upsertGoogleUser({ sub: "g-gamze", email: "gamze@example.com", name: "Gamze", timezone: "Europe/Istanbul", refreshToken: secrets.encrypt(goodToken), calendarAccess: true }).user;
    const gamzeLink = db.addLinkCalendar(gamze.id, `${server.origin}/slow/gamze.ics`, "Slow");

    const pending: Promise<unknown>[] = [];
    try {
      const round = sync.syncNow();
      pending.push(round);
      // Her Google calendar is listed and read while every link still waits.
      await vi.waitFor(() => expect(calendar(gamze.id, "gamze@example.com")?.last_success).toEqual(expect.any(Number)), { timeout: 4000, interval: 20 });
      expect(calendar(gamze.id, gamzeLink).last_success).toBeNull();
      expect(slow.every((s) => calendar(s.user, s.id).last_success === null)).toBe(true);
      const releaser = setInterval(release, 20);
      await round;
      clearInterval(releaser);
      expect(slow.every((s) => calendar(s.user, s.id).last_success !== null)).toBe(true);

      // syncOne: Gamze's own slow link doesn't hold up her Google calendar either.
      db.db().prepare("UPDATE calendars SET last_success = NULL WHERE user_id = ?").run(gamze.id);
      const one = sync.syncOne(gamze.id);
      pending.push(one);
      await vi.waitFor(() => expect(calendar(gamze.id, "gamze@example.com").last_success).toEqual(expect.any(Number)), { timeout: 4000, interval: 20 });
      expect(calendar(gamze.id, gamzeLink).last_success).toBeNull();
      const releaser2 = setInterval(release, 20);
      await one;
      clearInterval(releaser2);
      expect(calendar(gamze.id, gamzeLink).last_success).toEqual(expect.any(Number));
    } finally {
      // Whatever happened, nothing is left waiting for the next test.
      server.handle((_req, res) => res.end(FEED));
      release();
      await Promise.allSettled(pending);
    }
  });
});

describe("CALENDAR_LINKS=off, or a value that isn't on, private or off (criterion 11, reading)", () => {
  it("reads no link, in syncOne or the round", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    // Public addresses, so that only the setting, not the private-address check, keeps them unread.
    const PUBLIC = "93.184.216.34";
    const undo = routePublicAddress(PUBLIC, server.port);
    try {
      const ahmet = person("Ahmet Yılmaz", "Europe/Istanbul");
      const elif = person("Elif Kaya", "Europe/Istanbul", "revoked");
      const a = db.addLinkCalendar(ahmet.id, `http://${PUBLIC}:${server.port}/off/a.ics`, "Side job");
      const e = db.addLinkCalendar(elif.id, `http://${PUBLIC}:${server.port}/off/e.ics`, "Side job");
      // The same links are read with CALENDAR_LINKS=on.
      process.env.CALENDAR_LINKS = "on";
      await sync.syncOne(ahmet.id);
      expect(hitsOn("/off/a.ics")).toHaveLength(1);
      server.hits.length = 0;
      const rows = () => [calendar(ahmet.id, a), calendar(elif.id, e)];
      const before = rows();

      for (const setting of ["off", "OFF", "yes", "public", "1"]) {
        process.env.CALENDAR_LINKS = setting;
        await sync.syncOne(ahmet.id);
        await sync.syncOne(elif.id);
        await sync.syncNow();
        expect(server.hits, setting).toEqual([]);
        // Not tried either: no attempt or error recorded.
        expect(rows(), setting).toEqual(before);
      }
    } finally {
      undo();
    }
  });
});

describe("whether someone's free time can be trusted, with calendar links (criterion 5)", () => {
  const now = 1_000_000_000_000;
  const fine = { refresh_token: "t", token_error: null, calendar_access: 1 };
  const revoked = { ...fine, token_error: "Google access expired or was revoked" };
  const noToken = { ...fine, refresh_token: null };
  const google = (last_success: number | null, error: string | null = null) => ({ kind: "google" as const, last_success, error });
  const link = (last_success: number | null, error: string | null = null) => ({ kind: "link" as const, last_success, error });
  const fresh = now - 60_000;
  const hoursOld = now - 7 * HOUR_MS;

  it("judges someone counting only links on those links, whatever their Google access", () => {
    for (const user of [fine, revoked, noToken, { ...revoked, refresh_token: null }]) {
      const who = JSON.stringify(user);
      expect(sync.dataStatus(user, [link(fresh)], now, false), who).toBe("ok");
      expect(sync.dataStatus(user, [link(fresh), link(null)], now, false), who).toBe("syncing");
      expect(sync.dataStatus(user, [link(null, "Couldn't reach that address.")], now, false), who).toBe("failing");
      expect(sync.dataStatus(user, [link(hoursOld, "The calendar took too long to answer.")], now, false), who).toBe("failing");
      expect(sync.dataStatus(user, [link(now - 30 * 60_000, "Couldn't reach that address.")], now, false), who).toBe("ok");
    }
  });

  it("is signInAgain only when a Google calendar counts and Google access is gone", () => {
    expect(sync.dataStatus(revoked, [google(fresh), link(fresh)], now, false)).toBe("signInAgain");
    expect(sync.dataStatus(noToken, [google(fresh), link(fresh)], now, false)).toBe("signInAgain");
    // Outside the demo only: the demo has no refresh tokens.
    expect(sync.dataStatus(noToken, [google(fresh), link(fresh)], now, true)).toBe("ok");
    // Without calendar access no Google calendar counts, so only the links decide.
    expect(sync.dataStatus({ ...revoked, calendar_access: 0 }, [google(fresh), link(fresh)], now, false)).toBe("ok");
    expect(sync.dataStatus({ ...noToken, calendar_access: 0 }, [google(null), link(null)], now, false)).toBe("syncing");
  });

  it("is noCalendars when nothing counts", () => {
    expect(sync.dataStatus(fine, [], now, false)).toBe("noCalendars");
    expect(sync.dataStatus({ ...fine, calendar_access: 0 }, [google(fresh)], now, false)).toBe("noCalendars");
    expect(sync.dataStatus({ ...revoked, calendar_access: 0 }, [google(fresh)], now, false)).toBe("noCalendars");
  });

  it("decides as before over Google calendars and links together", () => {
    expect(sync.dataStatus(fine, [google(fresh), link(fresh)], now, false)).toBe("ok");
    expect(sync.dataStatus(fine, [google(fresh), link(null)], now, false)).toBe("syncing");
    expect(sync.dataStatus(fine, [google(null), link(fresh)], now, false)).toBe("syncing");
    expect(sync.dataStatus(fine, [google(fresh), link(null, "That calendar is too big.")], now, false)).toBe("failing");
    expect(sync.dataStatus(fine, [google(fresh), link(hoursOld)], now, false)).toBe("failing");
    expect(sync.dataStatus(fine, [google(hoursOld), link(fresh)], now, false)).toBe("failing");
  });

  it("doesn't count links while CALENDAR_LINKS is off (criterion 11)", () => {
    for (const setting of ["off", "nonsense"]) {
      process.env.CALENDAR_LINKS = setting;
      expect(sync.dataStatus(revoked, [link(fresh)], now, false), setting).toBe("noCalendars");
      expect(sync.dataStatus(fine, [google(fresh), link(null, "Couldn't reach that address.")], now, false), setting).toBe("ok");
    }
  });
});
