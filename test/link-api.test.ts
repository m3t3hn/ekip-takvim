import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailabilityResponse, MySettings, StatusResponse } from "@/lib/types";
import {
  HOUR_MS,
  calendarServer,
  calendarText,
  captureConsole,
  closedPort,
  googleRefusesEveryToken,
  routePublicAddress,
  utcDay,
  utcMidnight,
  vevent,
  type CalendarServer,
} from "./link-helpers";

// Calendar links through the API, criteria 5 (availability), 7 to 11. The
// session cookie is a real one, read through the real viewer code; only
// next/headers' cookie jar is stood in for. Calendars are served from
// 127.0.0.1; nothing reaches the network.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const SECRET = "k".repeat(40);
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = SECRET;
process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 30\n";
process.env.CALENDAR_LINKS = "private";
delete process.env.DEMO_MODE;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const { NextRequest } = await import("next/server");
const db = await import("@/lib/server/db");
const secrets = await import("@/lib/server/secrets");
const sync = await import("@/lib/server/sync");
const { icsBusy, IcsError } = await import("@/lib/server/ics");
const meRoute = await import("@/app/api/me/route");
const meSyncRoute = await import("@/app/api/me/sync/route");
const calendarsRoute = await import("@/app/api/me/calendars/route");
const calendarRoute = await import("@/app/api/me/calendars/[id]/route");
const availabilityRoute = await import("@/app/api/availability/route");
const statusRoute = await import("@/app/api/status/route");
const eventRoute = await import("@/app/api/events/[ref]/route");

// Every link's path and query carry these; criterion 9 looks for them everywhere.
const PATH_MARK = "PathSecret";
const QUERY_MARK = "QuerySecret";
const REDIRECT_MARK = "RedirSecret";
const SECRETS = [PATH_MARK, QUERY_MARK, REDIRECT_MARK];

const D1 = utcDay(2);
const D2 = utcDay(3);
const FEED = calendarText(
  vevent("standup@side", "Side-job standup", `DTSTART:${D1}T100000Z`, `DTEND:${D1}T103000Z`),
  vevent("client@side", "Client call", `DTSTART:${D2}T140000Z`, `DTEND:${D2}T150000Z`, ["DESCRIPTION:Bring the mockups", "LOCATION:Kadıköy"]),
);
const FEED_TITLES = ["Side-job standup", "Client call"];
const TODAY = new Date().toISOString().slice(0, 10);

type Answer = { status: number; text: string; json: unknown };
const answers: string[] = [];
let lines: string[] = [];
let server: CalendarServer;
let n = 0;

async function answer(res: Response): Promise<Answer> {
  const text = await res.text();
  answers.push(text, JSON.stringify([...res.headers.entries()]));
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

/** "none": no refresh token; "working": one Google hasn't refused (no sync asks it here); "revoked": refused. */
function person(name: string, opts: { google?: "none" | "working" | "revoked"; calendarAccess?: boolean } = {}) {
  n++;
  const user = db.upsertGoogleUser({
    sub: `g-${n}`,
    email: `p${n}@example.com`,
    name,
    timezone: "Europe/Istanbul",
    refreshToken: opts.google === "revoked" || opts.google === "working" ? secrets.encrypt(`1//refresh-${n}`) : null,
    calendarAccess: opts.calendarAccess ?? true,
  }).user;
  if (opts.google === "revoked") db.setTokenError(user.id, "Google access expired or was revoked");
  return user;
}
const signIn = (userId: string) => {
  jar.session = secrets.sessionValue(db.getUser(userId)!).value;
};
const signOut = () => {
  jar.session = undefined;
};

/** A link on the test server whose path and query are marked secret. */
const secretLink = (tag: string, origin = server.origin) => `${origin}/${PATH_MARK}-${tag}/${PATH_MARK}.ics?token=${QUERY_MARK}-${tag}&v=2`;
const hitsFor = (tag: string) => server.hits.filter((h) => h.url.includes(`${PATH_MARK}-${tag}/`));

const getMe = async () => answer(await meRoute.GET());
const putMe = async (body: unknown) =>
  answer(await meRoute.PUT(new NextRequest("http://localhost/api/me", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })));
const refreshMe = async () => answer(await meSyncRoute.POST());
const post = async (body: unknown) =>
  answer(
    await calendarsRoute.POST(
      new NextRequest("http://localhost/api/me/calendars", {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
const remove = async (id: string) =>
  answer(
    await calendarRoute.DELETE(new NextRequest(`http://localhost/api/me/calendars/${encodeURIComponent(id)}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    }),
  );
const availability = async () =>
  answer(await availabilityRoute.GET(new NextRequest(`http://localhost/api/availability?start=${TODAY}&days=14&tz=UTC`)));
const status = async () => answer(await statusRoute.GET());
const event = async (ref: string) =>
  answer(await eventRoute.GET(new NextRequest(`http://localhost/api/events/${ref}`), { params: Promise.resolve({ ref }) }));

const settings = (a: Answer) => a.json as MySettings;
/** A link's name is its host, with or without the test server's port: never more of it. */
const hostOnly = (summary: string, hostname: string) => summary === hostname || summary === `${hostname}:${server.port}`;
const personIn = async (userId: string) => ((await availability()).json as AvailabilityResponse).people.find((p) => p.id === userId)!;
const linkCalendars = (userId: string) => db.listCalendars(userId).filter((c) => c.kind === "link");
const busyRows = (calendarId: string) => db.db().prepare("SELECT * FROM busy WHERE calendar_id = ?").all(calendarId) as Record<string, unknown>[];

function serveFeed(res: ServerResponse, text = FEED) {
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.end(text);
}

beforeAll(async () => {
  lines = captureConsole();
  server = await calendarServer();
  // The sync loop starts here, outside the demo and without Google: it reads nothing.
  sync.ensureStarted();
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  db.resetAll();
  signOut();
  server.hits.length = 0;
  googleRefusesEveryToken();
  server.handle((_req, res) => serveFeed(res));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.CALENDAR_LINKS = "private";
  process.env.SESSION_SECRET = SECRET;
  delete process.env.DEMO_MODE;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

describe("POST /api/me/calendars (criterion 7)", () => {
  it("is 401 without a session, or with one that no longer holds", async () => {
    const ahmet = person("Ahmet Yılmaz");
    expect((await post({ url: secretLink("anon"), label: "Side job" })).status).toBe(401);
    signIn(ahmet.id);
    db.bumpSessionVersion(ahmet.id);
    expect((await post({ url: secretLink("anon"), label: "Side job" })).status).toBe(401);
    const elif = person("Elif Kaya");
    signIn(elif.id);
    db.deleteUser(elif.id);
    expect((await post({ url: secretLink("anon"), label: "Side job" })).status).toBe(401);
    expect(hitsFor("anon")).toEqual([]);
    expect(linkCalendars(ahmet.id)).toEqual([]);
  });

  it("is 403 when calendar links are off, or CALENDAR_LINKS is none of on, private and off", async () => {
    const ahmet = person("Ahmet Yılmaz");
    signIn(ahmet.id);
    for (const setting of ["off", "Off", "nonsense", "true"]) {
      process.env.CALENDAR_LINKS = setting;
      expect((await post({ url: secretLink("off"), label: "Side job" })).status, setting).toBe(403);
      expect(settings(await getMe()).linksAllowed, setting).toBe(false);
    }
    expect(hitsFor("off")).toEqual([]);
    expect(linkCalendars(ahmet.id)).toEqual([]);
  });

  it("is 403 in the demo unless CALENDAR_LINKS is set; there a link is read when added, and the round stays off", async () => {
    process.env.DEMO_MODE = "true";
    delete process.env.CALENDAR_LINKS;
    const ahmet = person("Ahmet Yılmaz");
    signIn(ahmet.id);
    expect((await post({ url: secretLink("demo"), label: "Side job" })).status).toBe(403);
    expect(settings(await getMe()).linksAllowed).toBe(false);
    process.env.CALENDAR_LINKS = "off";
    expect((await post({ url: secretLink("demo"), label: "Side job" })).status).toBe(403);
    expect(hitsFor("demo")).toEqual([]);

    process.env.CALENDAR_LINKS = "private";
    expect(settings(await getMe()).linksAllowed).toBe(true);
    const added = await post({ url: secretLink("demo"), label: "Side job" });
    expect(added.status).toBe(200);
    expect(hitsFor("demo")).toHaveLength(1);
    const [cal] = linkCalendars(ahmet.id);
    expect(busyRows(cal.calendar_id).map((b) => b.title).sort()).toEqual([...FEED_TITLES].sort());

    await sync.syncNow();
    expect(hitsFor("demo")).toHaveLength(1);
  });

  it("is 400 for a label that breaks PUT /api/me's rule: 1 to 40 characters after trimming", async () => {
    const ahmet = person("Ahmet Yılmaz");
    signIn(ahmet.id);
    for (const label of ["", "   ", "x".repeat(41), `  ${"x".repeat(41)}  `, undefined, null, 42, ["Side job"]]) {
      const res = await post({ url: secretLink("label"), label });
      expect(res.status, JSON.stringify(label)).toBe(400);
      expect((res.json as { error?: unknown }).error, JSON.stringify(label)).toEqual(expect.any(String));
    }
    expect((await post("not json")).status).toBe(400);
    expect(linkCalendars(ahmet.id)).toEqual([]);
    // The same labels PUT /api/me turns down.
    const google = { team: null, timezone: "Europe/Istanbul", color: db.getUser(ahmet.id)!.color };
    expect((await putMe({ ...google, calendars: [{ id: "x", label: "x".repeat(41), included: true }] })).status).toBe(400);
    expect((await putMe({ ...google, calendars: [{ id: "x", label: "   ", included: true }] })).status).toBe(400);

    // At the edges: 40 characters after trimming, and one.
    expect((await post({ url: secretLink("label-40"), label: `  ${"y".repeat(40)}  ` })).status).toBe(200);
    expect((await post({ url: secretLink("label-1"), label: "Z" })).status).toBe(200);
    expect(linkCalendars(ahmet.id).map((c) => c.label).sort()).toEqual(["Z", "y".repeat(40)]);
  });

  it("is 400 for a url normalizeLink refuses", async () => {
    const ahmet = person("Ahmet Yılmaz");
    signIn(ahmet.id);
    for (const url of [
      "ftp://127.0.0.1/cal.ics",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "not a link",
      "",
      `http://user:${QUERY_MARK}@127.0.0.1:${server.port}/${PATH_MARK}.ics`,
      `${server.origin}/${"a".repeat(2100)}.ics`,
      undefined,
      null,
      42,
    ]) {
      const res = await post({ url, label: "Side job" });
      expect(res.status, String(url).slice(0, 60)).toBe(400);
    }
    expect(server.hits).toEqual([]);
    expect(linkCalendars(ahmet.id)).toEqual([]);
  });

  it("is 409 once the person has 10 calendar links, ticked or not", async () => {
    const ahmet = person("Ahmet Yılmaz");
    const elif = person("Elif Kaya");
    db.addLinkCalendar(elif.id, secretLink("elifs"), "Elif's");
    signIn(ahmet.id);
    for (let i = 0; i < 9; i++) db.addLinkCalendar(ahmet.id, secretLink(`pre-${i}`), `Link ${i}`);
    expect((await post({ url: secretLink("tenth"), label: "Tenth" })).status).toBe(200);
    expect(linkCalendars(ahmet.id)).toHaveLength(10);
    expect((await post({ url: secretLink("eleventh"), label: "Eleventh" })).status).toBe(409);
    const first = linkCalendars(ahmet.id)[0];
    db.updateCalendarChoices(ahmet.id, [{ id: first.calendar_id, label: first.label, included: false }]);
    expect((await post({ url: secretLink("eleventh"), label: "Eleventh" })).status).toBe(409);
    expect(linkCalendars(ahmet.id)).toHaveLength(10);
    // Another person's links don't count towards it.
    signIn(elif.id);
    expect((await post({ url: secretLink("elifs-2"), label: "Second" })).status).toBe(200);
  });

  it("is 400 with a plain message, a different one per reason, when the link can't be read", async () => {
    const ahmet = person("Ahmet Yılmaz");
    signIn(ahmet.id);
    const reasons: Record<string, string> = {};
    const refused = async (reason: string, url: string, handler?: (res: ServerResponse, url: string) => void) => {
      if (handler) server.handle((req, res) => handler(res, req.url ?? ""));
      const res = await post({ url, label: "Side job" });
      expect(res.status, reason).toBe(400);
      const message = (res.json as { error?: unknown }).error;
      expect(message, reason).toEqual(expect.any(String));
      reasons[reason] = message as string;
      expect(linkCalendars(ahmet.id), reason).toEqual([]);
    };

    await refused("invalid", "ftp://127.0.0.1/cal.ics");
    process.env.CALENDAR_LINKS = "on";
    await refused("blocked", secretLink("blocked"));
    expect(hitsFor("blocked")).toEqual([]);
    process.env.CALENDAR_LINKS = "private";
    await refused("unreachable", secretLink("unreachable", `http://127.0.0.1:${await closedPort()}`));
    await refused("http", secretLink("http"), (res, url) => {
      res.statusCode = 404;
      res.end(`No calendar at ${url}`);
    });
    await refused("notCalendar", secretLink("html"), (res, url) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<html><body>Sign in to see ${url}</body></html>`);
    });
    const notIcs = "BEGIN:VCALENDARX\r\nVERSION:2.0\r\nEND:VCALENDARX\r\n";
    expect(() => icsBusy(notIcs, { from: 0, to: Date.now(), timezone: "UTC" })).toThrow(IcsError);
    await refused("IcsError", secretLink("ics"), (res) => serveFeed(res, notIcs));
    await refused("tooManyRedirects", secretLink("loop"), (res, url) => {
      res.statusCode = 302;
      res.setHeader("Location", `/${REDIRECT_MARK}-${url.length}/${PATH_MARK}-loop/x.ics?r=${REDIRECT_MARK}`);
      res.end();
    });
    await refused("tooLarge", secretLink("large"), (res) => {
      res.setHeader("Content-Type", "text/calendar");
      res.setHeader("Content-Length", String(64 * 1024 * 1024));
      res.write("BEGIN:VCALENDAR\r\n");
    });
    // A server that never answers: the read gives up at its deadline, here brought forward.
    const realSetTimeout = globalThis.setTimeout;
    server.handle(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = post({ url: secretLink("slow"), label: "Side job" });
    while (hitsFor("slow").length === 0) await new Promise((r) => realSetTimeout(r, 10));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const slow = await pending;
    vi.useRealTimers();
    expect(slow.status).toBe(400);
    reasons.timeout = (slow.json as { error: string }).error;
    expect(linkCalendars(ahmet.id)).toEqual([]);

    const messages = Object.values(reasons);
    expect(Object.keys(reasons)).toHaveLength(9);
    expect(new Set(messages).size, JSON.stringify(reasons, null, 1)).toBe(9);
    for (const [reason, message] of Object.entries(reasons)) {
      expect(message.trim().length, reason).toBeGreaterThan(0);
      expect(message, reason).not.toMatch(/LinkError|IcsError|ECONN|\n\s+at |PathSecret|QuerySecret|RedirSecret/);
    }
    // Another server error is still told apart from the other reasons.
    server.handle((_req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    const unavailable = await post({ url: secretLink("503"), label: "Side job" });
    expect(unavailable.status).toBe(400);
    for (const [reason, message] of Object.entries(reasons)) {
      if (reason !== "http") expect((unavailable.json as { error: string }).error, reason).not.toBe(message);
    }
  });

  it("adds the calendar, stores its busy blocks at once, and answers with my settings as GET /api/me gives them", async () => {
    const ahmet = person("Ahmet Yılmaz");
    db.syncCalendarList(ahmet.id, [{ id: "ahmet@example.com", summary: "ahmet@example.com", access: "events", primary: true }]);
    signIn(ahmet.id);
    const added = await post({ url: secretLink("ok"), label: "  Side job  " });
    expect(added.status).toBe(200);
    expect(hitsFor("ok")).toHaveLength(1);
    expect(added.json).toEqual((await getMe()).json);

    const mine = settings(added);
    expect(mine.linksAllowed).toBe(true);
    expect(mine.calendars.map((c) => c.kind)).toEqual(["google", "link"]);
    expect(mine.calendars[1]).toMatchObject({ kind: "link", label: "Side job", included: true });
    expect(hostOnly(mine.calendars[1].summary, "127.0.0.1")).toBe(true);
    const [cal] = linkCalendars(ahmet.id);
    expect(mine.calendars[1].id).toBe(cal.calendar_id);
    expect(cal.last_success).not.toBeNull();
    expect(busyRows(cal.calendar_id).map((b) => b.title).sort()).toEqual([...FEED_TITLES].sort());
    const blocks = (await personIn(ahmet.id)).busy.filter((b) => b.label === "Side job");
    expect(blocks.map((b) => b.start)).toEqual([utcMidnight(D1) + 10 * HOUR_MS, utcMidnight(D2) + 14 * HOUR_MS]);
  });
});

describe("DELETE /api/me/calendars/[id] (criterion 8)", () => {
  async function setUp() {
    const ahmet = person("Ahmet Yılmaz");
    const elif = person("Elif Kaya");
    db.syncCalendarList(ahmet.id, [{ id: "ahmet@example.com", summary: "ahmet@example.com", access: "events", primary: true }]);
    db.setBusy(ahmet.id, "ahmet@example.com", [{ start: utcMidnight(D1) + 6 * HOUR_MS, end: utcMidnight(D1) + 7 * HOUR_MS, title: "Work thing", eventId: "w1" }]);
    signIn(elif.id);
    expect((await post({ url: secretLink("elif"), label: "Yoga" })).status).toBe(200);
    signIn(ahmet.id);
    expect((await post({ url: secretLink("ahmet"), label: "Side job" })).status).toBe(200);
    return { ahmet, elif, mine: linkCalendars(ahmet.id)[0].calendar_id, elifs: linkCalendars(elif.id)[0].calendar_id };
  }
  const everything = () => ({
    calendars: db.db().prepare("SELECT * FROM calendars ORDER BY rowid").all(),
    busy: db.db().prepare("SELECT * FROM busy ORDER BY rowid").all(),
  });

  it("is 401 without a session", async () => {
    const { mine } = await setUp();
    const before = everything();
    signOut();
    expect((await remove(mine)).status).toBe(401);
    expect(everything()).toEqual(before);
  });

  it("is 404 unless the id is one of the signed-in person's calendar links", async () => {
    const { elifs } = await setUp();
    const before = everything();
    for (const id of ["ahmet@example.com", elifs, "link-00000000-0000-4000-8000-000000000000", "nothing"]) {
      expect((await remove(id)).status, id).toBe(404);
      expect(everything(), id).toEqual(before);
    }
  });

  it("removes the calendar and its busy blocks, and answers with my settings", async () => {
    const { ahmet, mine } = await setUp();
    expect(busyRows(mine).length).toBeGreaterThan(0);
    const removed = await remove(mine);
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual((await getMe()).json);
    expect(settings(removed).calendars.map((c) => c.id)).toEqual(["ahmet@example.com"]);
    expect(linkCalendars(ahmet.id)).toEqual([]);
    expect(busyRows(mine)).toEqual([]);
    expect((await personIn(ahmet.id)).busy.map((b) => b.label)).toEqual(["Work"]);
    expect((await remove(mine)).status).toBe(404);
  });
});

describe("other people see a calendar link's events by its label only (criterion 10)", () => {
  it("shows its owner the titles and refs, and others the label alone", async () => {
    const ahmet = person("Ahmet Yılmaz");
    const elif = person("Elif Kaya");
    signIn(ahmet.id);
    expect((await post({ url: secretLink("titles"), label: "Side job" })).status).toBe(200);

    const own = (await personIn(ahmet.id)).busy.filter((b) => b.label === "Side job");
    expect(own.map((b) => b.title)).toEqual(FEED_TITLES);
    expect(own.every((b) => typeof b.ref === "string")).toBe(true);
    const opened = await event(own[1].ref!);
    expect(opened.status).toBe(200);
    expect(opened.json).toMatchObject({ title: "Client call", label: "Side job", description: "Bring the mockups", location: "Kadıköy" });

    for (const viewer of [elif.id, null]) {
      if (viewer) signIn(viewer);
      else signOut();
      const seen = (await personIn(ahmet.id)).busy.filter((b) => b.label === "Side job");
      expect(seen, String(viewer)).toHaveLength(2);
      for (const block of seen) {
        expect(block, String(viewer)).not.toHaveProperty("title");
        expect(block, String(viewer)).not.toHaveProperty("ref");
      }
      for (const b of own) expect((await event(b.ref!)).status, String(viewer)).toBe(404);
    }
  });
});

describe("CALENDAR_LINKS through the API (criterion 11)", () => {
  it("unset or on: takes links to public addresses, not to private ones", async () => {
    const PUBLIC = "93.184.216.34";
    const undo = routePublicAddress(PUBLIC, server.port);
    try {
      const ahmet = person("Ahmet Yılmaz");
      signIn(ahmet.id);
      for (const setting of [undefined, "on", " ON "]) {
        if (setting === undefined) delete process.env.CALENDAR_LINKS;
        else process.env.CALENDAR_LINKS = setting;
        const tag = `public-${String(setting).trim()}`;
        const res = await post({ url: secretLink(tag, `http://${PUBLIC}:${server.port}`), label: "Public" });
        expect(res.status, String(setting)).toBe(200);
        expect(hitsFor(tag), String(setting)).toHaveLength(1);
        expect(hitsFor(tag)[0].headers.host).toBe(`${PUBLIC}:${server.port}`);
        expect(settings(res).linksAllowed).toBe(true);

        const local = await post({ url: secretLink(`${tag}-local`), label: "Local" });
        expect(local.status, String(setting)).toBe(400);
        expect(hitsFor(`${tag}-local`)).toEqual([]);
      }
      const summaries = settings(await getMe()).calendars.map((c) => c.summary);
      expect(summaries).toHaveLength(3);
      for (const summary of summaries) expect(hostOnly(summary, PUBLIC), summary).toBe(true);
    } finally {
      undo();
    }
  });

  it("private: takes private and local addresses too", async () => {
    const ahmet = person("Ahmet Yılmaz");
    signIn(ahmet.id);
    for (const setting of ["private", " Private "]) {
      process.env.CALENDAR_LINKS = setting;
      expect((await post({ url: secretLink(`private-${setting.trim()}`), label: "Home" })).status, setting).toBe(200);
    }
  });

  it("off, or another value: existing links are neither read nor counted", async () => {
    const ahmet = person("Ahmet Yılmaz");
    const elif = person("Elif Kaya", { google: "working" });
    db.syncCalendarList(elif.id, [{ id: "elif@example.com", summary: "elif@example.com", access: "events", primary: true }]);
    db.setBusy(elif.id, "elif@example.com", [{ start: utcMidnight(D1) + 6 * HOUR_MS, end: utcMidnight(D1) + 7 * HOUR_MS, title: "Elif's work", eventId: "e1" }]);
    signIn(elif.id);
    expect((await post({ url: secretLink("elif-off"), label: "Yoga" })).status).toBe(200);
    // Elif's link fails from here on: while links count, that makes her data stale.
    db.setCalendarError(elif.id, linkCalendars(elif.id)[0].calendar_id, "Couldn't reach that address.");
    expect(await personIn(elif.id)).toMatchObject({ data: "ok", stale: true, calendars: ["Work", "Yoga"] });
    signIn(ahmet.id);
    expect((await post({ url: secretLink("ahmet-off"), label: "Side job" })).status).toBe(200);
    const refs = (await personIn(ahmet.id)).busy.map((b) => b.ref!);
    expect(refs).toHaveLength(2);
    const hits = server.hits.length;
    const linkRows = () => [...linkCalendars(ahmet.id), ...linkCalendars(elif.id)];
    const rowsBefore = linkRows();
    // While links count, the status page lists them by kind.
    const counted = ((await status()).json as StatusResponse).calendars;
    expect(counted.map((r) => [r.label, r.kind]).sort()).toEqual([["Side job", "link"], ["Work", "google"], ["Yoga", "link"]]);

    for (const setting of ["off", "disabled"]) {
      process.env.CALENDAR_LINKS = setting;
      // Saving the settings page and "Refresh" read the person's calendars: not their links.
      const mine = settings(await getMe());
      expect(mine.linksAllowed).toBe(false);
      expect((await putMe({ team: null, timezone: "Europe/Istanbul", color: mine.color, calendars: mine.calendars.map((c) => ({ id: c.id, label: c.label, included: c.included })) })).status).toBe(200);
      expect((await refreshMe()).status).toBe(200);
      expect(server.hits.length, setting).toBe(hits);
      // Not tried either: no attempt or error recorded.
      expect(linkRows(), setting).toEqual(rowsBefore);

      const people = ((await availability()).json as AvailabilityResponse).people;
      const a = people.find((p) => p.id === ahmet.id)!;
      const e = people.find((p) => p.id === elif.id)!;
      expect(a.calendars, setting).toEqual([]);
      expect(a.busy, setting).toEqual([]);
      expect(a.data, setting).toBe("noCalendars");
      expect(e.calendars, setting).toEqual(["Work"]);
      expect(e.busy.map((b) => b.label), setting).toEqual(["Work"]);
      expect(e.data, setting).toBe("ok");
      expect(e.stale, setting).toBe(false);
      const rows = ((await status()).json as StatusResponse).calendars;
      expect(rows.map((r) => r.label), setting).toEqual(["Work"]);
      expect(rows.some((r) => r.kind === "link"), setting).toBe(false);
      for (const ref of refs) expect((await event(ref)).status, setting).toBe(404);
    }

    // Back on, they count again.
    process.env.CALENDAR_LINKS = "private";
    expect((await personIn(ahmet.id)).calendars).toEqual(["Side job"]);
    expect((await event(refs[0])).status).toBe(200);
  });
});

describe("pending and stale in /api/availability (criterion 5)", () => {
  it("count a Google token problem only when a Google calendar of the person's counts", async () => {
    const fresh = (userId: string, calendarId: string) =>
      db.setBusy(userId, calendarId, [{ start: utcMidnight(D1) + 9 * HOUR_MS, end: utcMidnight(D1) + 10 * HOUR_MS, title: "x", eventId: `${userId}-${calendarId}` }]);
    const google = (userId: string, id: string) => {
      db.syncCalendarList(userId, [{ id, summary: id, access: "events", primary: true }]);
      return id;
    };

    // Google access gone, only a link counts, and it reads fine.
    const linkOnly = person("Link Only", { google: "revoked" });
    fresh(linkOnly.id, db.addLinkCalendar(linkOnly.id, secretLink("p1"), "Side job"));
    // Google access gone with a Google calendar counted beside the link.
    const both = person("Both Kinds", { google: "revoked" });
    fresh(both.id, google(both.id, "both@example.com"));
    fresh(both.id, db.addLinkCalendar(both.id, secretLink("p2"), "Side job"));
    // No refresh token, and a link not read yet.
    const waitingLink = person("Waiting Link");
    db.addLinkCalendar(waitingLink.id, secretLink("p3"), "Side job");
    // No refresh token, and a Google calendar not read yet: it never will be.
    const waitingGoogle = person("Waiting Google");
    google(waitingGoogle.id, "waiting@example.com");
    // No calendar access: a ticked Google calendar with an error doesn't count; the link does.
    const noAccess = person("No Access", { google: "revoked", calendarAccess: false });
    db.syncCalendarList(noAccess.id, [{ id: "noaccess@example.com", summary: "x", access: "events", primary: true }]);
    db.setCalendarError(noAccess.id, "noaccess@example.com", "Google refused");
    fresh(noAccess.id, db.addLinkCalendar(noAccess.id, secretLink("p5"), "Side job"));
    // A link that failed after reading fine once.
    const failing = person("Failing Link");
    const failingId = db.addLinkCalendar(failing.id, secretLink("p6"), "Side job");
    fresh(failing.id, failingId);
    db.setCalendarError(failing.id, failingId, "Couldn't reach that address.");

    const people = ((await availability()).json as AvailabilityResponse).people;
    const of = (id: string) => {
      const p = people.find((x) => x.id === id)!;
      return { data: p.data, pending: p.pending, stale: p.stale };
    };
    expect(of(linkOnly.id)).toEqual({ data: "ok", pending: false, stale: false });
    expect(of(both.id)).toEqual({ data: "signInAgain", pending: false, stale: true });
    expect(of(waitingLink.id)).toEqual({ data: "syncing", pending: true, stale: false });
    expect(of(waitingGoogle.id)).toEqual({ data: "signInAgain", pending: false, stale: false });
    expect(of(noAccess.id)).toEqual({ data: "ok", pending: false, stale: false });
    expect(of(failing.id)).toEqual({ data: "ok", pending: false, stale: true });
  });
});

describe("a calendar link when the day turns: /api/availability's last covered day (criterion 6, fix round 1)", () => {
  it("POST keeps a version to ask about that day; the next day's first sync reads in full, so the owner is busy on the last covered day", async () => {
    // One event every day at 20:00 UTC; the server answers 304 to a request naming its version.
    const daily = calendarText(vevent("daily@side", "Evening check-in", "DTSTART:20260101T200000Z", "DTEND:20260101T203000Z", ["RRULE:FREQ=DAILY"]));
    const etag = '"daily-1"';
    const lastModified = "Thu, 12 Nov 2026 09:00:00 GMT";
    server.handle((req, res) => {
      if (req.headers["if-none-match"] === etag) {
        res.statusCode = 304;
        return void res.end();
      }
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", lastModified);
      serveFeed(res, daily);
    });
    const FULL = { etag: undefined, since: undefined };
    const CONDITIONAL = { etag, since: lastModified };
    const asked = () => hitsFor("daily").map((h) => ({ etag: h.headers["if-none-match"], since: h.headers["if-modified-since"] }));
    const at = (iso: string) => vi.setSystemTime(Date.parse(iso));
    /** One day on /api/availability in UTC, the team's zone: the days covered, and the owner on that day. */
    const dayOf = async (userId: string, day: string) => {
      const body = (await answer(await availabilityRoute.GET(new NextRequest(`http://localhost/api/availability?start=${day}&days=1&tz=UTC`)))).json as AvailabilityResponse;
      const p = body.people.find((x) => x.id === userId)!;
      return { coverage: body.coverage, busy: p.busy.length, data: p.data, stale: p.stale, pending: p.pending };
    };

    vi.useFakeTimers({ toFake: ["Date"] });
    at("2026-11-13T23:00:00Z");
    const ahmet = person("Ahmet Yılmaz");
    signIn(ahmet.id);
    expect((await post({ url: secretLink("daily"), label: "Side job" })).status).toBe(200);
    expect(asked()).toEqual([FULL]);
    expect((await dayOf(ahmet.id, "2026-11-13")).coverage.to).toBe("2026-12-13");
    expect(await dayOf(ahmet.id, "2026-12-13")).toMatchObject({ busy: 1, data: "ok", stale: false });

    // Half an hour later, the same day: what POST read is asked about, and the 304 keeps it.
    at("2026-11-13T23:30:00Z");
    await sync.syncOne(ahmet.id);
    expect(asked()).toEqual([FULL, CONDITIONAL]);

    // 01:00 the next day: the window moved, so the link is read in full though its last full read is two hours old.
    at("2026-11-14T01:00:00Z");
    await sync.syncOne(ahmet.id);
    expect(asked()).toEqual([FULL, CONDITIONAL, FULL]);
    expect((await dayOf(ahmet.id, "2026-11-14")).coverage.to).toBe("2026-12-14");
    expect(await dayOf(ahmet.id, "2026-12-14")).toMatchObject({ busy: 1, data: "ok", stale: false, pending: false });

    // Later that day the window holds: asked again, and the 304 keeps the last day's block.
    at("2026-11-14T05:00:00Z");
    await sync.syncOne(ahmet.id);
    expect(asked()).toEqual([FULL, CONDITIONAL, FULL, CONDITIONAL]);
    expect(await dayOf(ahmet.id, "2026-12-14")).toMatchObject({ busy: 1, data: "ok", stale: false, pending: false });
  });
});

describe("a link's path and query never leave the server (criterion 9)", () => {
  it("are in no answer, stored error or log line, on the way in, on every failure and after", async () => {
    const ahmet = person("Ahmet Yılmaz");
    const elif = person("Elif Kaya");
    db.syncCalendarList(ahmet.id, [{ id: "ahmet@example.com", summary: "ahmet@example.com", access: "events", primary: true }]);
    signIn(ahmet.id);

    // Failures on the way in, the server echoing what it was asked for.
    const echo = (status: number) => (req: { url?: string }, res: ServerResponse) => {
      res.statusCode = status;
      res.setHeader("X-Requested", req.url ?? "");
      res.end(`${status} for ${req.url}`);
    };
    for (const status of [401, 403, 404, 410, 500, 503]) {
      server.handle(echo(status));
      expect((await post({ url: secretLink(`in-${status}`), label: "Side job" })).status).toBe(400);
    }
    server.handle((req, res) => {
      res.statusCode = 301;
      res.setHeader("Location", `${server.origin}/${REDIRECT_MARK}/${PATH_MARK}-next.ics?token=${REDIRECT_MARK}`);
      res.end(`Moved from ${req.url}`);
    });
    expect((await post({ url: secretLink("in-redirects"), label: "Side job" })).status).toBe(400);
    server.handle((req, res) => {
      if (req.url?.startsWith(`/${REDIRECT_MARK}`)) return echo(404)(req, res);
      res.statusCode = 302;
      res.setHeader("Location", `/${REDIRECT_MARK}/${PATH_MARK}-moved.ics?token=${REDIRECT_MARK}`);
      res.end();
    });
    expect((await post({ url: secretLink("in-moved"), label: "Side job" })).status).toBe(400);
    server.handle((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<html>${req.url}</html>`);
    });
    expect((await post({ url: secretLink("in-html"), label: "Side job" })).status).toBe(400);
    process.env.CALENDAR_LINKS = "on";
    expect((await post({ url: secretLink("in-blocked"), label: "Side job" })).status).toBe(400);
    process.env.CALENDAR_LINKS = "private";
    expect((await post({ url: secretLink("in-closed", `http://127.0.0.1:${await closedPort()}`), label: "Side job" })).status).toBe(400);

    // Added, then failing in every way while it's read again, from every path that reads it.
    server.handle((_req, res) => serveFeed(res));
    const added = await post({ url: secretLink("kept"), label: "Side job" });
    expect(added.status).toBe(200);
    const id = linkCalendars(ahmet.id)[0].calendar_id;
    const failures: ((req: { url?: string }, res: ServerResponse) => void)[] = [
      echo(404),
      echo(500),
      (req, res) => {
        res.statusCode = 302;
        res.setHeader("Location", `/${REDIRECT_MARK}/${PATH_MARK}-later.ics?token=${REDIRECT_MARK}`);
        res.end(`Moved from ${req.url}`);
      },
      (req, res) => {
        if (req.url?.startsWith(`/${REDIRECT_MARK}`)) return echo(403)(req, res);
        res.statusCode = 307;
        res.setHeader("Location", `${server.origin}/${REDIRECT_MARK}/${PATH_MARK}.ics?token=${REDIRECT_MARK}`);
        res.end();
      },
      (req, res) => res.end(`<p>${req.url}</p>`),
      (req, res) => serveFeed(res, `BEGIN:VCALENDARX\r\nX-URL:${req.url}\r\nEND:VCALENDARX\r\n`),
    ];
    const errors: string[] = [];
    for (const [i, fail] of failures.entries()) {
      server.handle(fail);
      const mine = settings(await getMe());
      const put = await putMe({ team: null, timezone: "Europe/Istanbul", color: mine.color, calendars: mine.calendars.map((c) => ({ id: c.id, label: c.label, included: c.included })) });
      expect(put.status, `failure ${i}`).toBe(200);
      const error = linkCalendars(ahmet.id)[0].error;
      expect(error, `failure ${i}`).toEqual(expect.any(String));
      errors.push(error!);
      await sync.syncOne(ahmet.id);
      await getMe();
      await status();
      await availability();
    }
    server.handle(echo(404));
    expect((await refreshMe()).status).toBe(200);
    process.env.SESSION_SECRET = "another secret that is at least 32 characters";
    await sync.syncOne(ahmet.id);
    process.env.SESSION_SECRET = SECRET;
    errors.push(linkCalendars(ahmet.id)[0].error!);

    // Read again, then everything that shows it, to its owner and to others.
    server.handle((_req, res) => serveFeed(res));
    await sync.syncOne(ahmet.id);
    const mine = await getMe();
    expect(hostOnly(settings(mine).calendars.find((c) => c.id === id)!.summary, "127.0.0.1")).toBe(true);
    for (const viewer of [ahmet.id, elif.id, null]) {
      if (viewer) signIn(viewer);
      else signOut();
      const people = (await availability()).json as AvailabilityResponse;
      for (const b of people.people.flatMap((p) => p.busy)) if (b.ref) await event(b.ref);
      await status();
    }
    signIn(ahmet.id);
    expect((await remove(id)).status).toBe(200);

    expect(server.hits.length).toBeGreaterThan(20);
    const everywhere = {
      answers: answers.join("\n"),
      storedErrors: errors.join("\n"),
      logs: lines.join("\n"),
      database: JSON.stringify(db.db().prepare("SELECT * FROM calendars").all()) + JSON.stringify(db.db().prepare("SELECT * FROM busy").all()),
    };
    expect(answers.length).toBeGreaterThan(50);
    expect(lines.some((l) => l.includes("Side job"))).toBe(true);
    for (const [where, text] of Object.entries(everywhere)) {
      for (const secret of SECRETS) expect(text.toLowerCase().includes(secret.toLowerCase()), `${secret} in ${where}`).toBe(false);
    }
  });
});
