import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGoogle, type FakeGoogle } from "./google-fake";
import { calendarServer, calendarText, captureConsole, utcDay, vevent, type CalendarServer, type Handler } from "./link-helpers";

// Sync every minute, criterion 5: a round (the scheduler's, or the main page's
// Refresh, POST /api/sync) asks for a calendar link only when nothing asked for
// it in the last 10 minutes (adding it, a round, its owner's own sync), whatever
// came of that; the owner's sign-in, Save and Refresh from Google read at once;
// with refresh_minutes 10 or more every round reads every link. Calendars are
// served from 127.0.0.1 (CALENDAR_LINKS=private), Google is a fetch stub, and
// the clock is a fake Date.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const SECRET = "f".repeat(40);
const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = SECRET;
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
// Rounds read nothing unless Google sign-in is set up.
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
delete process.env.DEMO_MODE;
delete process.env.EXPOSURE;
delete process.env.APP_URL;
delete process.env.CONFIG_PATH;

const { NextRequest } = await import("next/server");
const db = await import("@/lib/server/db");
const secrets = await import("@/lib/server/secrets");
const sync = await import("@/lib/server/sync");
const meRoute = await import("@/app/api/me/route");
const meSyncRoute = await import("@/app/api/me/sync/route");
const calendarsRoute = await import("@/app/api/me/calendars/route");
const syncRoute = await import("@/app/api/sync/route");
const callbackRoute = await import("@/app/auth/google/callback/route");

const MIN = 60_000;
const DAY = 86_400_000;
const realSetTimeout = globalThis.setTimeout;
const D1 = utcDay(2);
const FEED = calendarText(vevent("standup@side", "Side-job standup", `DTSTART:${D1}T100000Z`, `DTEND:${D1}T103000Z`));
const ETAG = '"v1"';

let server: CalendarServer;
let google: FakeGoogle;
/** Per link tag, what its server does; FEED with an ETag otherwise. */
let routes: Map<string, Handler>;
/** Each request to a link: its tag, when on the clock, and whether it asked what changed. */
let asked: { tag: string; at: number; conditional: boolean }[];
/** The start of the current test on the fake clock: later in every test, so the Refresh cooldowns never carry over. */
let T = Math.floor(Date.now() / DAY) * DAY + 9 * 3_600_000;

const feed: Handler = (req, res) => {
  if (req.headers["if-none-match"] === ETAG) {
    res.statusCode = 304;
    return void res.end();
  }
  res.setHeader("ETag", ETAG);
  res.setHeader("Content-Type", "text/calendar");
  res.end(FEED);
};

beforeAll(async () => {
  captureConsole();
  server = await calendarServer();
  server.handle((req: IncomingMessage, res: ServerResponse) => {
    const tag = /^\/floor\/([^/]+)\//.exec(req.url ?? "")?.[1] ?? "";
    asked.push({ tag, at: Date.now(), conditional: req.headers["if-none-match"] !== undefined });
    (routes.get(tag) ?? feed)(req, res);
  });
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  db.resetAll();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.google-tokens")];
  jar.session = undefined;
  routes = new Map();
  asked = [];
  google = fakeGoogle();
  T += 3 * DAY;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useConfig(CONFIG);
  process.env.CALENDAR_LINKS = "private";
});

let configs = 0;
/** Another team config. An inline config is read again when its length changes, so each gets a comment of its own length. */
function useConfig(yaml: string) {
  process.env.CONFIG_YAML = yaml === CONFIG ? CONFIG : `${yaml}# ${"x".repeat(1000 * ++configs)}\n`;
  return sync.getConfig()!;
}

let n = 0;
type Person = { id: string; sub: string; email: string; name: string };
/** Someone who signed in with Google without granting it calendar access: only their calendar links are read. */
function person(name = "Person"): Person {
  n++;
  const p = { sub: `g-${n}`, email: `p${n}@example.com`, name: `${name} ${n}` };
  const { user } = db.upsertGoogleUser({ ...p, timezone: "UTC", refreshToken: null, calendarAccess: false });
  return { ...p, id: user.id };
}
const signIn = (p: Person) => {
  jar.session = secrets.sessionValue(db.getUser(p.id)!).value;
};
const linkUrl = (tag: string) => `${server.origin}/floor/${tag}/basic.ics?key=k-${tag}`;
const hits = (tag: string) => asked.filter((a) => a.tag === tag);
const times = (tag: string) => hits(tag).map((a) => a.at - T);
const linkOf = (p: Person) => db.listCalendars(p.id).find((c) => c.kind === "link")!;

/** Add a link through POST /api/me/calendars, as its owner does: it's read there. */
async function addLink(p: Person, tag: string): Promise<string> {
  signIn(p);
  const res = await calendarsRoute.POST(
    new NextRequest("http://localhost/api/me/calendars", {
      method: "POST",
      body: JSON.stringify({ url: linkUrl(tag), label: "Side job" }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(res.status, tag).toBe(200);
  return linkOf(p).calendar_id;
}

/** A round, as the scheduler runs it, at `at` on the clock. */
async function roundAt(at: number): Promise<void> {
  vi.setSystemTime(at);
  await sync.syncNow();
}
/** The main page's Refresh at `at`: POST /api/sync, and the round it starts. Returns the answer's status. */
async function refreshAt(at: number): Promise<number> {
  vi.setSystemTime(at);
  const res = await syncRoute.POST();
  if (res.status === 202) await sync.syncNow();
  return res.status;
}
/** The owner's Save on My settings (PUT /api/me) at `at`. */
async function saveAt(p: Person, at: number): Promise<void> {
  vi.setSystemTime(at);
  signIn(p);
  const mine = (await (await meRoute.GET()).json()) as { timezone: string; color: string; calendars: { id: string; label: string; included: boolean }[] };
  const res = await meRoute.PUT(
    new NextRequest("http://localhost/api/me", {
      method: "PUT",
      body: JSON.stringify({ team: null, timezone: mine.timezone, color: mine.color, calendars: mine.calendars.map(({ id, label, included }) => ({ id, label, included })) }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(res.status).toBe(200);
}
/** The owner's Refresh from Google on My settings (POST /api/me/sync) at `at`. */
async function refreshMineAt(p: Person, at: number): Promise<void> {
  vi.setSystemTime(at);
  signIn(p);
  expect((await meSyncRoute.POST()).status).toBe(200);
}
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; !done(); i++) {
    if (i > 600) throw new Error(`test: waited too long for ${what}`);
    await new Promise((r) => realSetTimeout(r, 5));
  }
}

describe("rounds ask for a calendar link at most every 10 minutes (criterion 5)", () => {
  it("with no refresh_minutes (1): a link added at T isn't asked for by the rounds before T + 10 min, and is by the first from then on", async () => {
    expect(useConfig(CONFIG).refreshMinutes).toBe(1);
    const ayse = person();
    await addLink(ayse, "added");
    expect(times("added")).toEqual([0]);
    for (let m = 1; m <= 9; m++) await roundAt(T + m * MIN);
    await roundAt(T + 10 * MIN - 1);
    expect(times("added")).toEqual([0]);
    await roundAt(T + 10 * MIN);
    expect(times("added")).toEqual([0, 10 * MIN]);
    // The round's own request starts the next 10 minutes.
    for (let m = 11; m <= 19; m++) await roundAt(T + m * MIN);
    await roundAt(T + 20 * MIN - 1);
    expect(times("added")).toEqual([0, 10 * MIN]);
    await roundAt(T + 20 * MIN);
    expect(times("added")).toEqual([0, 10 * MIN, 20 * MIN]);
    expect(linkOf(ayse)).toMatchObject({ error: null, last_success: T + 20 * MIN });
  });

  it("rounds every minute for an hour ask for each link every 10 minutes, counted from when it was added", async () => {
    const ayse = person();
    const burak = person();
    await addLink(ayse, "hourly-a");
    for (let m = 1; m <= 60; m++) {
      if (m === 3) {
        vi.setSystemTime(T + m * MIN);
        await addLink(burak, "hourly-b");
      }
      await roundAt(T + m * MIN);
    }
    expect(times("hourly-a")).toEqual([0, 10, 20, 30, 40, 50, 60].map((m) => m * MIN));
    expect(times("hourly-b")).toEqual([3, 13, 23, 33, 43, 53].map((m) => m * MIN));
  });

  const OUTCOMES: [string, Handler, string | null][] = [
    ["read in full", (_req, res) => {
      res.setHeader("Content-Type", "text/calendar");
      res.end(FEED);
    }, null],
    ["unchanged (304)", feed, null],
    ["a 500", (_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    }, "The calendar's server answered 500."],
    ["a 404 (the link was reset)", (_req, res) => {
      res.statusCode = 404;
      res.end("gone");
    }, "The link didn't work. It may have been reset: remove this calendar and add the new link."],
    ["not a calendar", (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end("<html>sign in</html>");
    }, "That address didn't return a calendar."],
    ["the connection dropped", (req) => void req.socket.destroy(), "Couldn't reach that address."],
  ];

  it.each(OUTCOMES)("whatever came of a round's request (%s): the rounds of the next 10 minutes leave the link alone, the first after asks", async (_name, outcome, error) => {
    const ayse = person();
    await addLink(ayse, "outcome");
    routes.set("outcome", outcome);
    const t = T + 10 * MIN;
    await roundAt(t);
    expect(times("outcome")).toEqual([0, 10 * MIN]);
    expect(linkOf(ayse).error).toBe(error);
    routes.delete("outcome");
    for (let m = 1; m <= 9; m++) await roundAt(t + m * MIN);
    await roundAt(t + 10 * MIN - 1);
    expect(times("outcome")).toEqual([0, 10 * MIN]);
    await roundAt(t + 10 * MIN);
    expect(times("outcome")).toEqual([0, 10 * MIN, 20 * MIN]);
    expect(linkOf(ayse).error).toBeNull();
  });

  it("a link whose server answers slowly when it's added: rounds count from when adding asked for it, not from when it was stored", async () => {
    const ayse = person();
    routes.set("slow-add", (req, res) => {
      vi.setSystemTime(Date.now() + 2 * MIN);
      feed(req, res);
    });
    await addLink(ayse, "slow-add");
    routes.delete("slow-add");
    expect(times("slow-add")).toEqual([0]);
    expect(linkOf(ayse).last_success).toBe(T + 2 * MIN);
    await roundAt(T + 3 * MIN);
    await roundAt(T + 10 * MIN - 1);
    expect(times("slow-add")).toEqual([0]);
    await roundAt(T + 10 * MIN);
    expect(times("slow-add")).toEqual([0, 10 * MIN]);
  });

  it("a slow link: asked for at T and answered a minute later, it's asked for again by the first round from T + 10 min", async () => {
    const ayse = person();
    await addLink(ayse, "slow");
    const t = T + 10 * MIN;
    // The answer comes a minute after the request.
    routes.set("slow", (req, res) => {
      vi.setSystemTime(Date.now() + MIN);
      feed(req, res);
    });
    await roundAt(t);
    routes.delete("slow");
    expect(times("slow")).toEqual([0, 10 * MIN]);
    expect(linkOf(ayse)).toMatchObject({ error: null, last_success: t + MIN });
    for (let m = 2; m <= 9; m++) await roundAt(t + m * MIN);
    await roundAt(t + 10 * MIN - 1);
    expect(times("slow")).toEqual([0, 10 * MIN]);
    await roundAt(t + 10 * MIN);
    expect(times("slow")).toEqual([0, 10 * MIN, 20 * MIN]);
  });

  it("a link that times out: asked for at T, given up on 20 s later, it's asked for again by the first round from T + 10 min", async () => {
    const ayse = person();
    await addLink(ayse, "hangs");
    const t = T + 10 * MIN;
    routes.set("hangs", () => {});
    // The read's deadline is a timer: bring it forward.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(t);
    try {
      const round = sync.syncNow();
      await until(() => hits("hangs").length === 2, "the round's request");
      await vi.advanceTimersByTimeAsync(20_000);
      await round;
    } finally {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date"] });
    }
    routes.delete("hangs");
    expect(linkOf(ayse)).toMatchObject({ error: "The calendar took too long to answer." });
    expect(linkOf(ayse).last_attempt).toBeGreaterThanOrEqual(t + 20_000);
    await roundAt(t + 5 * MIN);
    await roundAt(t + 10 * MIN - 1);
    expect(times("hangs")).toEqual([0, 10 * MIN]);
    await roundAt(t + 10 * MIN);
    expect(times("hangs")).toEqual([0, 10 * MIN, 20 * MIN]);
    expect(linkOf(ayse).error).toBeNull();
  });

  it("a link never asked for (added before this change, or straight into the database) is read by the next round", async () => {
    const ayse = person();
    const burak = person();
    db.addLinkCalendar(ayse.id, linkUrl("never-a"), "Side job");
    db.addLinkCalendar(burak.id, linkUrl("never-b"), "Side job");
    await roundAt(T);
    expect(times("never-a")).toEqual([0]);
    expect(times("never-b")).toEqual([0]);
    await roundAt(T + MIN);
    await roundAt(T + 9 * MIN);
    expect(times("never-a")).toEqual([0]);
    await roundAt(T + 10 * MIN);
    expect(times("never-a")).toEqual([0, 10 * MIN]);
    expect(times("never-b")).toEqual([0, 10 * MIN]);
  });

  it("the owner's Save, Refresh from Google and sign-in read their link at once, a minute after a round did; the rounds after count from the last of them", async () => {
    const ayse = person();
    await addLink(ayse, "owner");
    await roundAt(T + 10 * MIN);
    expect(times("owner")).toEqual([0, 10 * MIN]);

    await saveAt(ayse, T + 11 * MIN);
    expect(times("owner")).toEqual([0, 10, 11].map((m) => m * MIN));
    await refreshMineAt(ayse, T + 12 * MIN);
    expect(times("owner")).toEqual([0, 10, 11, 12].map((m) => m * MIN));
    // Signing in again: Google's callback, then the sync it starts.
    vi.setSystemTime(T + 13 * MIN);
    google.signIns.set("code-owner", { sub: ayse.sub, email: ayse.email, name: ayse.name, refreshToken: `1//refresh-${ayse.sub}`, expiresIn: 3600 });
    const res = await callbackRoute.GET(
      new NextRequest("http://localhost/auth/google/callback?code=code-owner&state=st", { headers: { cookie: "ekip_oauth_state=st" } }),
    );
    expect(res.headers.get("location")).not.toContain("signin=");
    await until(() => hits("owner").length === 5, "the sign-in's sync");
    expect(times("owner")).toEqual([0, 10, 11, 12, 13].map((m) => m * MIN));

    for (let m = 14; m <= 22; m++) await roundAt(T + m * MIN);
    await roundAt(T + 23 * MIN - 1);
    expect(times("owner")).toHaveLength(5);
    await roundAt(T + 23 * MIN);
    expect(times("owner")).toEqual([0, 10, 11, 12, 13, 23].map((m) => m * MIN));
  });

  it("Save and Refresh from Google read at once even a few seconds after adding the link or after each other", async () => {
    const ayse = person();
    await addLink(ayse, "eager");
    await saveAt(ayse, T + 1000);
    await refreshMineAt(ayse, T + 2000);
    await saveAt(ayse, T + 3000);
    expect(times("eager")).toEqual([0, 1000, 2000, 3000]);
    await roundAt(T + 4000);
    await roundAt(T + 10 * MIN + 2999);
    expect(times("eager")).toHaveLength(4);
    await roundAt(T + 10 * MIN + 3000);
    expect(times("eager")).toHaveLength(5);
  });

  it("the main page's Refresh (POST /api/sync) is a round: it leaves a link asked for under 10 minutes ago alone, and asks for one asked for 10 minutes ago", async () => {
    const ayse = person();
    await addLink(ayse, "refresh");
    expect(await refreshAt(T + 5 * MIN)).toBe(202);
    expect(times("refresh")).toEqual([0]);
    expect(await refreshAt(T + 10 * MIN)).toBe(202);
    expect(times("refresh")).toEqual([0, 10 * MIN]);
    // Its 30-second cooldown is as it was.
    expect(await refreshAt(T + 10 * MIN + 10_000)).toBe(429);
    expect(await refreshAt(T + 10 * MIN + 40_000)).toBe(202);
    expect(times("refresh")).toEqual([0, 10 * MIN]);
    expect(await refreshAt(T + 20 * MIN)).toBe(202);
    expect(times("refresh")).toEqual([0, 10 * MIN, 20 * MIN]);
  });

  it("a link its owner's own sync asks for while a round waits to read it isn't asked for again by that round", async () => {
    // Three slow links ahead of Elif's in the round's queue (three at a time).
    const slow = ["Aa", "Ab", "Ac"].map((name, i) => {
      const p = person(name);
      db.addLinkCalendar(p.id, linkUrl(`queued-${i}`), "Slow");
      return p;
    });
    const elif = person("Zz");
    db.addLinkCalendar(elif.id, linkUrl("elif"), "Side job");
    expect(slow.every((p) => p.id < elif.id)).toBe(true);
    const held: ServerResponse[] = [];
    for (let i = 0; i < 3; i++) routes.set(`queued-${i}`, (_req, res) => void held.push(res));

    const round = roundAt(T);
    await until(() => held.length === 3, "the slow links");
    await refreshMineAt(elif, T + 1000);
    expect(times("elif")).toEqual([1000]);
    for (let i = 0; i < 3; i++) routes.delete(`queued-${i}`);
    for (const res of held.splice(0)) feed({ headers: {} } as IncomingMessage, res);
    await round;
    expect(times("elif")).toEqual([1000]);
    await roundAt(T + 10 * MIN + 999);
    expect(times("elif")).toEqual([1000]);
    await roundAt(T + 10 * MIN + 1000);
    expect(times("elif")).toEqual([1000, 10 * MIN + 1000]);
  });

  it.each([10, 11, 60, 1440])("with refresh_minutes %i, every round reads every counted link, as today", async (minutes) => {
    expect(useConfig(`timezone: UTC\nhorizon_days: 30\nrefresh_minutes: ${minutes}\n`).refreshMinutes).toBe(minutes);
    const ayse = person();
    const burak = person();
    await addLink(ayse, "every");
    db.addLinkCalendar(burak.id, linkUrl("every-b"), "Side job");
    await roundAt(T);
    await roundAt(T + MIN);
    expect(await refreshAt(T + 2 * MIN)).toBe(202);
    await saveAt(ayse, T + 3 * MIN);
    await roundAt(T + 3 * MIN);
    expect(times("every")).toEqual([0, 0, 1, 2, 3, 3].map((m) => m * MIN));
    expect(times("every-b")).toEqual([0, 1, 2, 3].map((m) => m * MIN));
  });

  it.each([2, 9])("with refresh_minutes %i, rounds keep to 10 minutes too", async (minutes) => {
    expect(useConfig(`timezone: UTC\nhorizon_days: 30\nrefresh_minutes: ${minutes}\n`).refreshMinutes).toBe(minutes);
    const ayse = person();
    await addLink(ayse, "under");
    await roundAt(T + minutes * MIN);
    await roundAt(T + 10 * MIN - 1);
    expect(times("under")).toEqual([0]);
    await roundAt(T + 10 * MIN);
    expect(times("under")).toEqual([0, 10 * MIN]);
  });

  it("the conditional-read and daily-full-read rules hold under it: over a 25-hour day, rounds ask what changed every 10 minutes and read in full a day after the last full read, and when the day turns", async () => {
    // 25 October 2026 has 25 hours in Berlin: 22:00 UTC on the 24th to 23:00 UTC on the 25th.
    expect(useConfig("timezone: Europe/Berlin\nhorizon_days: 30\n")).toMatchObject({ timezone: "Europe/Berlin", refreshMinutes: 1 });
    const t0 = Date.parse("2026-10-24T22:00:00Z");
    vi.setSystemTime(t0);
    routes.set("day", (req, res) => {
      if (req.headers["if-none-match"] === ETAG) {
        res.statusCode = 304;
        return void res.end();
      }
      res.setHeader("ETag", ETAG);
      res.setHeader("Content-Type", "text/calendar");
      res.end(calendarText(vevent("fixed@side", "Fixed", "DTSTART:20261030T100000Z", "DTEND:20261030T110000Z")));
    });
    const ayse = person();
    signIn(ayse);
    const added = await calendarsRoute.POST(
      new NextRequest("http://localhost/api/me/calendars", { method: "POST", body: JSON.stringify({ url: linkUrl("day"), label: "Side job" }), headers: { "Content-Type": "application/json" } }),
    );
    expect(added.status).toBe(200);
    const blocks = db.db().prepare("SELECT start_ms, end_ms FROM busy WHERE calendar_id = ?").all(linkOf(ayse).calendar_id);
    expect(blocks).toHaveLength(1);
    for (let m = 5; m <= 25 * 60; m += 5) await roundAt(t0 + m * MIN);
    const day = asked.filter((a) => a.tag === "day");
    const minutes = day.map((a) => (a.at - t0) / MIN);
    expect(minutes).toEqual(Array.from({ length: 151 }, (_, i) => i * 10));
    const full = day.filter((a) => !a.conditional).map((a) => (a.at - t0) / MIN);
    // Added (a full read), a day later (the window still holds), and at midnight in Berlin (a new window).
    expect(full).toEqual([0, 24 * 60, 25 * 60]);
    expect(db.db().prepare("SELECT start_ms, end_ms FROM busy WHERE calendar_id = ?").all(linkOf(ayse).calendar_id)).toEqual(blocks);
    expect(linkOf(ayse)).toMatchObject({ error: null, last_success: t0 + 25 * 60 * MIN });
  });
});

describe("someone Google refused (fix round 1, item 3)", () => {
  it("rounds leave their Google access alone for 10 minutes after Google refused it, but their calendar link keeps to its own 10 minutes", async () => {
    const can = person();
    // Can signed in with Google too, and Google refuses his refresh token from now on.
    db.upsertGoogleUser({ sub: can.sub, email: can.email, name: can.name, timezone: "UTC", refreshToken: secrets.encrypt(`1//refused-${n}`), calendarAccess: true });
    await addLink(can, "refused-owner");
    // Google refuses him at T+4: he's marked, and his link, asked for at T, isn't due.
    await roundAt(T + 4 * MIN);
    expect(db.getUser(can.id)!.token_error).toEqual(expect.any(String));
    for (let m = 5; m <= 13; m++) await roundAt(T + m * MIN);
    expect(google.refreshes().map((c) => (c.at - T) / MIN), "token requests, minutes from T").toEqual([4]);
    expect(times("refused-owner")).toEqual([0, 10 * MIN]);
    expect(linkOf(can)).toMatchObject({ error: null, last_success: T + 10 * MIN });
    await roundAt(T + 14 * MIN);
    expect(google.refreshes().map((c) => (c.at - T) / MIN), "token requests, minutes from T").toEqual([4, 14]);
    expect(times("refused-owner")).toEqual([0, 10 * MIN]);
  });
});
