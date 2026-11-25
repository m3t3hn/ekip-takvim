import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGoogle, plans, type Account, type FakeGoogle, type TokenPlan } from "./google-fake";
import { calendarServer, calendarText, captureConsole, utcDay, vevent, type CalendarServer, type Handler } from "./link-helpers";

// Sync every minute, fix: the 10-minute waits when the server's clock is set
// back (criteria 1 and 2). With refresh_minutes 1, a round leaves a calendar
// link alone for 10 minutes after any request to it, and someone Google refused
// alone for 10 minutes after the refusal. A request or a refusal recorded later
// than now means the clock was set back since: the next round asks, and the
// usual 10 minutes count from what it asked. A time equal to now is 0 ms ago.
// Calendars are served from 127.0.0.1 (CALENDAR_LINKS=private), Google is a
// fetch stub, and the clock is a fake Date the tests set back.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const SECRET = "c".repeat(40);
const CONFIG = "timezone: UTC\nhorizon_days: 30\nrefresh_minutes: 1\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = SECRET;
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
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
const viewer = await import("@/lib/server/viewer");
const calendarsRoute = await import("@/app/api/me/calendars/route");
const syncRoute = await import("@/app/api/sync/route");

const MIN = 60_000;
const DAY = 86_400_000;
const D1 = utcDay(2);
const FEED = calendarText(vevent("standup@side", "Side-job standup", `DTSTART:${D1}T100000Z`, `DTEND:${D1}T103000Z`));

let server: CalendarServer;
let google: FakeGoogle;
let lines: string[] = [];
/** Per link tag, what its server does; FEED otherwise. */
let routes: Map<string, Handler>;
/** Each request to a link: its tag and when, on the clock. */
let asked: { tag: string; at: number }[];
/** When each round of the current test ran, on the clock. */
let ran: number[];
/**
 * The start of the current test on the fake clock. Each test starts 3 days
 * after the last one, and its clock never runs more than a day and a few
 * minutes ahead of it: no time a test records is later than the next test's.
 */
let T = Math.floor(Date.now() / DAY) * DAY + 8 * 3_600_000;

const feed: Handler = (_req, res) => {
  res.setHeader("Content-Type", "text/calendar");
  res.end(FEED);
};

beforeAll(async () => {
  server = await calendarServer();
  server.handle((req, res) => {
    const tag = /^\/clock\/([^/]+)\//.exec(req.url ?? "")?.[1] ?? "";
    asked.push({ tag, at: Date.now() });
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
  ran = [];
  lines = captureConsole();
  google = fakeGoogle();
  T += 3 * DAY;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

type Person = { id: string; sub: string; email: string; name: string; refreshToken: string | null };
let n = 0;

/**
 * Someone who signed in with Google. With `calendarAccess` (the default) they
 * gave it access to their calendars: a refresh token Google takes, and their
 * primary calendar there. Without it, only their calendar links are read.
 */
function person(calendarAccess = true): Person {
  n++;
  const p = { sub: `g-${n}`, email: `p${n}@example.com`, name: `Person ${n}`, refreshToken: calendarAccess ? `1//refresh-${n}` : null };
  if (p.refreshToken) google.accounts.set(p.refreshToken, { email: p.email, calendars: [{ id: p.email }] });
  const { user } = db.upsertGoogleUser({
    sub: p.sub,
    email: p.email,
    name: p.name,
    timezone: "UTC",
    refreshToken: p.refreshToken && secrets.encrypt(p.refreshToken),
    calendarAccess,
  });
  return { ...p, id: user.id };
}

const user = (p: Person) => db.getUser(p.id)!;
const cookieOf = (p: Person) => secrets.sessionValue(user(p)).value;
const linkUrl = (tag: string) => `${server.origin}/clock/${tag}/basic.ics?key=k-${tag}`;
const linkOf = (p: Person) => db.listCalendars(p.id).find((c) => c.kind === "link")!;
/** When each request to the link tagged `tag` came, in ms from T. */
const times = (tag: string) => asked.filter((a) => a.tag === tag).map((a) => a.at - T);
/** When token requests asked for `p`'s refresh token, in ms from T. */
const askedAt = (p: Person) => google.refreshes(p.refreshToken!).map((c) => c.at - T);
/** When `p`'s calendar list was read from Google, in ms from T. */
const listedAt = (p: Person) =>
  google.api().filter((c) => c.kind === "list" && google.issued.get(c.token)?.email === p.email).map((c) => c.at - T);
/** "google access lost" lines about `p`. */
const lost = (p: Person) => lines.filter((l) => l.includes('"msg":"google access lost"') && l.includes(`"user":"${p.id}"`)).length;
/** Every minute from `from` to `to` minutes after `t0`, both included. */
const everyMinute = (t0: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => t0 + (from + i) * MIN);

/** `p` adds a calendar link at `at` through POST /api/me/calendars, as on My settings: it's read there. */
async function addLinkAt(p: Person, tag: string, at: number): Promise<void> {
  vi.setSystemTime(at);
  jar.session = cookieOf(p);
  const res = await calendarsRoute.POST(
    new NextRequest("http://localhost/api/me/calendars", {
      method: "POST",
      body: JSON.stringify({ url: linkUrl(tag), label: "Side job" }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(res.status, tag).toBe(200);
}

/** A round, as the scheduler runs it, at `at` on the clock. */
async function roundAt(at: number): Promise<void> {
  vi.setSystemTime(at);
  ran.push(at);
  await sync.syncNow();
}
/** A round at each of these times, in order. */
async function rounds(...at: number[]): Promise<void> {
  for (const t of at) await roundAt(t);
}
/** The main page's Refresh at `at`: POST /api/sync, and the round it starts. */
async function refreshAt(at: number): Promise<void> {
  vi.setSystemTime(at);
  ran.push(at);
  expect((await syncRoute.POST()).status, "the main page's Refresh").toBe(202);
  await sync.syncNow();
}

/**
 * `p` left and their account was suspended: from now on Google refuses their
 * refresh token (invalid_grant) and turns down the access tokens it gave them.
 * Returns their account, to give it back.
 */
function suspend(p: Person): Account {
  const account = google.accounts.get(p.refreshToken!)!;
  google.accounts.delete(p.refreshToken!);
  return account;
}

// ---------------------------------------------------------------------------

describe("a calendar link last asked for later than now: the server's clock was set back (criterion 1)", () => {
  it("set back a day: the next round reads the link; from that read, the rounds before read + 10 min leave it alone, the first from read + 10 min reads it, and so on", async () => {
    const ayse = person(false);
    // The server's clock runs a day ahead: Ayşe adds her link, and the next rounds leave it alone.
    await addLinkAt(ayse, "day", T + DAY);
    await rounds(T + DAY + MIN, T + DAY + 2 * MIN);
    expect(times("day")).toEqual([DAY]);

    // The clock is set back a day.
    const read = T + 3 * MIN;
    await roundAt(read);
    expect(times("day"), "the first round after the clock was set back").toEqual([DAY, 3 * MIN]);
    await rounds(...everyMinute(read, 1, 9), read + 10 * MIN - 1);
    expect(times("day")).toEqual([DAY, 3 * MIN]);
    await roundAt(read + 10 * MIN);
    expect(times("day")).toEqual([DAY, 3 * MIN, 13 * MIN]);
    await rounds(...everyMinute(read, 11, 19), read + 20 * MIN - 1);
    expect(times("day")).toEqual([DAY, 3 * MIN, 13 * MIN]);
    await roundAt(read + 20 * MIN);
    expect(times("day")).toEqual([DAY, 3 * MIN, 13 * MIN, 23 * MIN]);
    expect(linkOf(ayse)).toMatchObject({ error: null, last_success: read + 20 * MIN });
  });

  it.each([
    ["1 ms", 1],
    ["a minute", MIN],
    ["10 minutes", 10 * MIN],
    ["a day", DAY],
  ] as [string, number][])(
    "set back by %s just after the link was read: the next round reads it; the main page's Refresh at that same moment doesn't (0 ms ago); the first round from 10 minutes on does",
    async (_name, back) => {
      const ayse = person(false);
      await addLinkAt(ayse, "back", T + back);
      await roundAt(T);
      expect(times("back"), "the round after the clock was set back").toEqual([back, 0]);
      await refreshAt(T);
      await rounds(T + 5 * MIN, T + 10 * MIN - 1);
      expect(times("back")).toEqual([back, 0]);
      await roundAt(T + 10 * MIN);
      expect(times("back")).toEqual([back, 0, 10 * MIN]);
    },
  );

  it("the edge at now: set back to exactly when one link was asked for, 1 ms before another was: the round reads the one asked for later than now, not the one asked for at now (0 ms ago); both from 10 minutes on", async () => {
    const ayse = person(false);
    const burak = person(false);
    const at = T + DAY;
    await addLinkAt(ayse, "at-now", at);
    await addLinkAt(burak, "after-now", at + 1);
    await roundAt(at + 5 * MIN);
    expect([times("at-now"), times("after-now")]).toEqual([[DAY], [DAY + 1]]);

    // The clock is set back to `at`.
    await roundAt(at);
    expect(times("after-now"), "asked for 1 ms later than now").toEqual([DAY + 1, DAY]);
    expect(times("at-now"), "asked for at now").toEqual([DAY]);
    await roundAt(at + 10 * MIN - 1);
    expect([times("at-now"), times("after-now")]).toEqual([[DAY], [DAY + 1, DAY]]);
    await roundAt(at + 10 * MIN);
    expect([times("at-now"), times("after-now")]).toEqual([
      [DAY, DAY + 10 * MIN],
      [DAY + 1, DAY, DAY + 10 * MIN],
    ]);
  });

  const OUTCOMES: [string, Handler, string][] = [
    ["a 500", (_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    }, "The calendar's server answered 500."],
    ["not a calendar", (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end("<html>sign in</html>");
    }, "That address didn't return a calendar."],
    ["its server unreachable: the connection dropped", (req) => void req.socket.destroy(), "Couldn't reach that address."],
  ];

  it.each(OUTCOMES)("whatever comes of the round's request after the clock was set back (%s), the next 10 minutes count from it", async (_name, outcome, error) => {
    const ayse = person(false);
    await addLinkAt(ayse, "outcome", T + DAY);
    routes.set("outcome", outcome);
    await roundAt(T);
    expect(times("outcome")).toEqual([DAY, 0]);
    expect(linkOf(ayse).error).toBe(error);
    routes.delete("outcome");
    await rounds(...everyMinute(T, 1, 9), T + 10 * MIN - 1);
    expect(times("outcome")).toEqual([DAY, 0]);
    await roundAt(T + 10 * MIN);
    expect(times("outcome")).toEqual([DAY, 0, 10 * MIN]);
    expect(linkOf(ayse).error).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("someone Google refused, the refusal recorded later than now: the server's clock was set back (criterion 2)", () => {
  it.each([
    ["the scheduler's round", roundAt],
    ["the main page's Refresh (POST /api/sync)", refreshAt],
  ] as [string, (at: number) => Promise<void>][])(
    "refused and marked while the clock ran a day ahead: %s after it's set back asks Google for him, with one token request; refused again, he stays marked once; the 10 minutes then count from that refusal",
    async (_name, next) => {
      const ayse = person();
      const burak = person();
      const ahead = T + DAY;
      await roundAt(ahead);
      const cookie = cookieOf(burak);
      const version = user(burak).session_version;
      // He left: Google refuses his refresh token at ahead + 1 min, and the next rounds leave him alone.
      suspend(burak);
      await rounds(ahead + MIN, ahead + 2 * MIN, ahead + 3 * MIN);
      const first = user(burak).token_error;
      expect(first).toEqual(expect.any(String));
      expect(askedAt(burak)).toEqual([DAY, DAY + MIN]);
      expect(user(burak).session_version).toBe(version + 1);
      expect(lost(burak)).toBe(1);

      // The clock is set back a day.
      const t = T + 4 * MIN;
      await next(t);
      expect(askedAt(burak), "token requests for him, ms from T").toEqual([DAY, DAY + MIN, 4 * MIN]);
      expect(user(burak).token_error, "his token_error").toBe(first);
      expect(user(burak).session_version, "his sessions ended again").toBe(version + 1);
      expect(lost(burak), '"google access lost" lines').toBe(1);
      expect(viewer.userForSession(cookie)).toBeNull();
      expect(sync.getStatus().signInAgain.map((e) => e.personId)).toEqual([burak.id]);

      await rounds(...everyMinute(t, 1, 9), t + 10 * MIN - 1);
      expect(askedAt(burak)).toEqual([DAY, DAY + MIN, 4 * MIN]);
      await roundAt(t + 10 * MIN);
      expect(askedAt(burak)).toEqual([DAY, DAY + MIN, 4 * MIN, 14 * MIN]);
      expect(user(burak).token_error).toBe(first);
      expect(user(burak).session_version).toBe(version + 1);
      expect(lost(burak)).toBe(1);
      // Everyone else is read in every round.
      expect(listedAt(ayse)).toEqual(ran.map((at) => at - T));
      expect(user(ayse).token_error).toBeNull();
    },
  );

  it("marked before a restart, with a message of its own, and refused again while the clock ran a day ahead: after it's set back, one token request; refused again, token_error keeps that first message, no session is ended again and nothing is logged", async () => {
    const burak = person();
    // He left, and a server that has restarted since marked him.
    suspend(burak);
    db.setTokenError(burak.id, "Token has been expired or revoked.");
    db.bumpSessionVersion(burak.id);
    const version = user(burak).session_version;
    // The clock runs a day ahead: a round asks Google for him, which refuses again.
    await rounds(T + DAY, T + DAY + MIN);
    expect(askedAt(burak)).toEqual([DAY]);

    // The clock is set back a day.
    await roundAt(T);
    expect(askedAt(burak), "token requests for him, ms from T").toEqual([DAY, 0]);
    expect(user(burak).token_error).toBe("Token has been expired or revoked.");
    expect(user(burak).session_version, "his sessions ended again").toBe(version);
    expect(lost(burak), '"google access lost" lines').toBe(0);
    await rounds(T + 5 * MIN, T + 10 * MIN - 1);
    expect(askedAt(burak)).toEqual([DAY, 0]);
    await roundAt(T + 10 * MIN);
    expect(askedAt(burak)).toEqual([DAY, 0, 10 * MIN]);
    expect(user(burak).token_error).toBe("Token has been expired or revoked.");
    expect(user(burak).session_version).toBe(version);
    expect(lost(burak)).toBe(0);
  });

  it("the edge at now: set back to exactly when Google refused Burak, 1 ms before it refused Cem: the round asks for Cem (refused later than now), not for Burak (refused at now: 0 ms ago); both from 10 minutes on", async () => {
    const burak = person();
    const cem = person();
    const at = T + DAY;
    suspend(burak);
    await roundAt(at);
    suspend(cem);
    await rounds(at + 1, at + 5 * MIN);
    expect(askedAt(burak)).toEqual([DAY]);
    expect(askedAt(cem)).toEqual([DAY, DAY + 1]);
    expect([user(burak).token_error, user(cem).token_error]).toEqual([expect.any(String), expect.any(String)]);

    // The clock is set back to `at`.
    await roundAt(at);
    expect(askedAt(cem), "Cem: refused 1 ms later than now").toEqual([DAY, DAY + 1, DAY]);
    expect(askedAt(burak), "Burak: refused at now").toEqual([DAY]);
    await roundAt(at + 10 * MIN - 1);
    expect([askedAt(burak), askedAt(cem)]).toEqual([[DAY], [DAY, DAY + 1, DAY]]);
    await roundAt(at + 10 * MIN);
    expect([askedAt(burak), askedAt(cem)]).toEqual([
      [DAY, DAY + 10 * MIN],
      [DAY, DAY + 1, DAY, DAY + 10 * MIN],
    ]);
    expect([lost(burak), lost(cem)]).toEqual([1, 1]);
  });

  it.each([
    ["no connection", plans.noConnection()],
    ["a 5xx", plans.serverError()],
    ["a timeout", plans.timeout()],
  ] as [string, TokenPlan][])(
    "Google unreachable (%s) rather than refusing after the clock was set back: he stays marked once and the next round asks again; once Google refuses, the 10 minutes count from that refusal",
    async (_name, failing) => {
      const burak = person();
      const cookie = cookieOf(burak);
      const version = user(burak).session_version;
      suspend(burak);
      await roundAt(T + DAY);
      const first = user(burak).token_error;
      expect(first).toEqual(expect.any(String));

      // The clock is set back a day, and Google can't be reached for two rounds.
      google.next(burak.refreshToken!, failing, failing);
      await roundAt(T);
      expect(askedAt(burak), "token requests for him, ms from T").toEqual([DAY, 0]);
      expect(user(burak).token_error).toBe(first);
      expect(user(burak).session_version, "his sessions ended again").toBe(version + 1);
      expect(lost(burak)).toBe(1);
      await roundAt(T + MIN);
      expect(askedAt(burak), "token requests for him, ms from T").toEqual([DAY, 0, MIN]);

      // Google answers again, and refuses.
      await roundAt(T + 2 * MIN);
      expect(askedAt(burak)).toEqual([DAY, 0, MIN, 2 * MIN]);
      await rounds(...everyMinute(T, 3, 11), T + 12 * MIN - 1);
      expect(askedAt(burak)).toEqual([DAY, 0, MIN, 2 * MIN]);
      await roundAt(T + 12 * MIN);
      expect(askedAt(burak)).toEqual([DAY, 0, MIN, 2 * MIN, 12 * MIN]);
      expect(user(burak).token_error).toBe(first);
      expect(user(burak).session_version).toBe(version + 1);
      expect(viewer.userForSession(cookie)).toBeNull();
      expect(lost(burak)).toBe(1);
    },
  );

  it("Google unreachable when the round after the set-back asks, then his access is back (an account restored): the next round asks, clears the mark and reads his calendar", async () => {
    const burak = person();
    const account = suspend(burak);
    await roundAt(T + DAY);
    expect(user(burak).token_error).toEqual(expect.any(String));

    google.next(burak.refreshToken!, plans.noConnection());
    await roundAt(T);
    expect(user(burak).token_error).toEqual(expect.any(String));
    google.accounts.set(burak.refreshToken!, account);
    await roundAt(T + MIN);
    expect(askedAt(burak)).toEqual([DAY, 0, MIN]);
    expect(user(burak).token_error).toBeNull();
    expect(db.listCalendars(burak.id).find((c) => c.calendar_id === burak.email)).toMatchObject({ last_success: T + MIN, error: null });
  });

  it("his calendar link and Google's refusal both recorded later than now: the next round reads the link and asks Google for him; each then waits its own 10 minutes", async () => {
    const can = person();
    await roundAt(T + DAY);
    await addLinkAt(can, "both", T + DAY + MIN);
    suspend(can);
    await rounds(T + DAY + 2 * MIN, T + DAY + 3 * MIN);
    expect(times("both")).toEqual([DAY + MIN]);
    expect(askedAt(can)).toEqual([DAY, DAY + 2 * MIN]);

    // The clock is set back a day.
    await roundAt(T);
    expect(times("both"), "requests to his link").toEqual([DAY + MIN, 0]);
    expect(askedAt(can), "token requests for him").toEqual([DAY, DAY + 2 * MIN, 0]);
    await rounds(...everyMinute(T, 1, 9), T + 10 * MIN - 1);
    expect(times("both")).toEqual([DAY + MIN, 0]);
    expect(askedAt(can)).toEqual([DAY, DAY + 2 * MIN, 0]);
    await roundAt(T + 10 * MIN);
    expect(times("both")).toEqual([DAY + MIN, 0, 10 * MIN]);
    expect(askedAt(can)).toEqual([DAY, DAY + 2 * MIN, 0, 10 * MIN]);
    expect(lost(can)).toBe(1);
  });
});
