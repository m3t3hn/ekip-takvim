import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGoogle, type Account, type FakeGoogle } from "./google-fake";
import { calendarServer, calendarText, captureConsole, utcDay, vevent, type CalendarServer } from "./link-helpers";

// Sync every minute, fix: a hot reload (criterion 3). `next dev` evaluates
// sync.ts again in the running process after an edit, and the new module takes
// the process-wide sync state it finds. A sync.ts from before the 10-minute wait
// for someone Google refused made that state without the record of refusals.
// With such a state, rounds run to the end, and a refusal in them is recorded,
// so the wait applies to that person. Route handlers and the scheduler load
// sync.ts apart, on the one state. refresh_minutes is 1, Google is a fetch stub,
// calendar links are served from 127.0.0.1 (CALENDAR_LINKS=private), and the
// clock is a fake Date.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const SECRET = "r".repeat(40);
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

// Nothing here loads sync.ts before a test has put an older state in place.
const db = await import("@/lib/server/db");
const secrets = await import("@/lib/server/secrets");
const config = await import("@/lib/server/config");

const KEY = Symbol.for("ekip-takvim.sync");
const MIN = 60_000;
const DAY = 86_400_000;
const D1 = utcDay(2);
const FEED = calendarText(vevent("standup@side", "Side-job standup", `DTSTART:${D1}T100000Z`, `DTEND:${D1}T103000Z`));

let server: CalendarServer;
let google: FakeGoogle;
let lines: string[] = [];
/** Each request to a link: its tag and when, on the clock. */
let asked: { tag: string; at: number }[];
/** The start of the current test on the fake clock: later in every test, so no cooldown carries over. */
let T = Math.floor(Date.now() / DAY) * DAY + 7 * 3_600_000;

beforeAll(async () => {
  server = await calendarServer();
  server.handle((req, res) => {
    asked.push({ tag: /^\/reload\/([^/]+)\//.exec(req.url ?? "")?.[1] ?? "", at: Date.now() });
    res.setHeader("Content-Type", "text/calendar");
    res.end(FEED);
  });
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  db.resetAll();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.google-tokens")];
  jar.session = undefined;
  asked = [];
  lines = captureConsole();
  google = fakeGoogle();
  T += 3 * DAY;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as Record<symbol, unknown>)[KEY];
});

// ---------------------------------------------------------------------------

/**
 * The process-wide sync state as an older sync.ts made it: every field it had
 * from the first commit on, and no record of Google's refusals. `after` is what
 * it holds once that sync.ts has run a while.
 */
function olderState(after: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    config: null,
    configError: null,
    configVersion: null,
    running: null,
    syncedAt: null,
    lastManual: 0,
    lastRefresh: new Map<string, number>(),
    timer: null,
    started: false,
    ...after,
  };
}

/**
 * sync.ts evaluated again in this process, as `next dev` does after an edit,
 * with `state` as the process-wide sync state; and the routes that use it.
 * Each call is one more copy of the module, as each bundle has its own.
 */
async function load(state: Record<string, unknown>) {
  (globalThis as Record<symbol, unknown>)[KEY] = state;
  vi.resetModules();
  return {
    sync: await import("@/lib/server/sync"),
    syncRoute: await import("@/app/api/sync/route"),
    meSyncRoute: await import("@/app/api/me/sync/route"),
  };
}
type Loaded = Awaited<ReturnType<typeof load>>;

type Person = { id: string; email: string; refreshToken: string };
let n = 0;
/** Someone who signed in with Google: a refresh token Google takes, and their primary calendar there. */
function person(): Person {
  n++;
  const p = { sub: `g-${n}`, email: `p${n}@example.com`, name: `Person ${n}`, refreshToken: `1//refresh-${n}` };
  google.accounts.set(p.refreshToken, { email: p.email, calendars: [{ id: p.email }] });
  const { user } = db.upsertGoogleUser({ sub: p.sub, email: p.email, name: p.name, timezone: "UTC", refreshToken: secrets.encrypt(p.refreshToken), calendarAccess: true });
  return { id: user.id, email: p.email, refreshToken: p.refreshToken };
}
/** `p` left: from now on Google refuses their refresh token (invalid_grant). */
function suspend(p: Person): Account {
  const account = google.accounts.get(p.refreshToken)!;
  google.accounts.delete(p.refreshToken);
  return account;
}

const user = (p: Person) => db.getUser(p.id)!;
const linkUrl = (tag: string) => `${server.origin}/reload/${tag}/basic.ics?key=k-${tag}`;
/** When each request to the link tagged `tag` came, in ms from T. */
const times = (tag: string) => asked.filter((a) => a.tag === tag).map((a) => a.at - T);
/** When token requests asked for `p`'s refresh token, in ms from T. */
const askedAt = (p: Person) => google.refreshes(p.refreshToken).map((c) => c.at - T);
/** When `p`'s calendar list was read from Google, in ms from T. */
const listedAt = (p: Person) =>
  google.api().filter((c) => c.kind === "list" && google.issued.get(c.token)?.email === p.email).map((c) => c.at - T);
const logged = (msg: string) => lines.filter((l) => l.includes(`"msg":"${msg}"`));
/** Lines saying a sync crashed: a round, or someone's own. */
const crashes = () => lines.filter((l) => l.includes("crashed"));
const lost = (p: Person) => logged("google access lost").filter((l) => l.includes(`"user":"${p.id}"`)).length;
/** Every minute from `from` to `to` minutes after T, both included. */
const minutes = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => T + (from + i) * MIN);

/** A round of this copy of sync.ts, as the scheduler runs it, at `at` on the clock. */
async function roundAt(copy: Loaded, at: number): Promise<void> {
  vi.setSystemTime(at);
  await copy.sync.syncNow();
}
/** The main page's Refresh through this copy's route at `at`: POST /api/sync, and the round it starts. */
async function refreshAt(copy: Loaded, at: number): Promise<void> {
  vi.setSystemTime(at);
  expect((await copy.syncRoute.POST()).status, "the main page's Refresh").toBe(202);
  await copy.sync.syncNow();
}

// ---------------------------------------------------------------------------

describe("sync.ts loaded into a process whose sync state an older sync.ts made, without the record of refusals (criterion 3)", () => {
  it("the state as it made it on start: the scheduler's rounds run to the end; Google refuses Burak in the first, the rounds of the next 10 minutes leave him alone and the first from then asks again", async () => {
    const ayse = person();
    const burak = person();
    db.addLinkCalendar(ayse.id, linkUrl("ayse"), "Side job");
    suspend(burak);
    const copy = await load(olderState());

    const at = [...minutes(0, 9), T + 10 * MIN - 1];
    for (const t of at) await roundAt(copy, t);
    expect(crashes(), "lines saying a sync crashed").toEqual([]);
    expect(logged("sync finished"), '"sync finished" lines').toHaveLength(at.length);
    expect(listedAt(ayse), "Ayşe's Google reads").toEqual(at.map((t) => t - T));
    expect(times("ayse"), "requests to Ayşe's link").toEqual([0]);
    expect(user(burak).token_error).toEqual(expect.any(String));
    expect(lost(burak)).toBe(1);
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0]);

    await roundAt(copy, T + 10 * MIN);
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0, 10 * MIN]);
    expect(times("ayse")).toEqual([0, 10 * MIN]);
    expect(lost(burak)).toBe(1);
    expect(crashes()).toEqual([]);
  });

  it("the state as it left it after running a while (config loaded, rounds done, both Refreshes used, started): the main page's Refresh runs its rounds to the end, and a refusal in one holds for 10 minutes", async () => {
    const ayse = person();
    const burak = person();
    suspend(burak);
    const copy = await load(
      olderState({
        config: config.loadConfig(),
        configVersion: config.configVersion(),
        syncedAt: T - MIN,
        lastManual: T - 5 * MIN,
        lastRefresh: new Map([[ayse.id, T - 2 * MIN]]),
        started: true,
      }),
    );

    for (const t of minutes(0, 9)) await refreshAt(copy, t);
    await roundAt(copy, T + 10 * MIN - 1);
    expect(crashes(), "lines saying a sync crashed").toEqual([]);
    expect(logged("sync finished"), '"sync finished" lines').toHaveLength(11);
    expect(user(burak).token_error).toEqual(expect.any(String));
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0]);
    await refreshAt(copy, T + 10 * MIN);
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0, 10 * MIN]);
    expect(listedAt(ayse)).toHaveLength(12);
    expect(lost(burak)).toBe(1);
    expect(crashes()).toEqual([]);
  });

  it("route handlers and the scheduler load sync.ts apart onto the older state, the routes' copy after a round: a refusal recorded by either copy holds in the other's rounds", async () => {
    const ayse = person();
    const burak = person();
    suspend(burak);
    const state = olderState();
    const scheduler = await load(state);
    await roundAt(scheduler, T);
    expect(askedAt(burak)).toEqual([0]);
    // A route is built when it's first asked for: its copy of sync.ts comes later, onto the same state.
    const routes = await load(state);

    for (const t of minutes(1, 9)) await refreshAt(routes, t);
    await roundAt(scheduler, T + 10 * MIN - 1);
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0]);
    await refreshAt(routes, T + 10 * MIN);
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0, 10 * MIN]);
    for (const t of minutes(11, 19)) await roundAt(scheduler, t);
    await roundAt(scheduler, T + 20 * MIN - 1);
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0, 10 * MIN]);
    await roundAt(scheduler, T + 20 * MIN);
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0, 10 * MIN, 20 * MIN]);
    // Ayşe is read in all 23 rounds, whichever copy ran them.
    expect(listedAt(ayse)).toHaveLength(23);
    expect(lost(burak)).toBe(1);
    expect(crashes()).toEqual([]);
  });

  it("beyond rounds, on the same state: Refresh from Google (POST /api/me/sync) of someone Google refuses marks them, and the rounds then leave them alone for 10 minutes", async () => {
    const burak = person();
    suspend(burak);
    const copy = await load(olderState());
    jar.session = secrets.sessionValue(user(burak)).value;
    const res = await copy.meSyncRoute.POST();
    expect(res.status).toBe(200);
    expect(crashes(), "lines saying a sync crashed").toEqual([]);
    expect(user(burak).token_error).toEqual(expect.any(String));
    expect(lost(burak)).toBe(1);

    for (const t of [...minutes(1, 9), T + 10 * MIN - 1]) await roundAt(copy, t);
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0]);
    await roundAt(copy, T + 10 * MIN);
    expect(askedAt(burak), "token requests for Burak, ms from T").toEqual([0, 10 * MIN]);
    expect(crashes()).toEqual([]);
  });
});
