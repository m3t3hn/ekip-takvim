import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureConsole } from "./link-helpers";
import { TOKEN_MARK, deferred as waiting, fakeGoogle, held as holding, plans, unauthorized, type Account, type ApiCall, type FakeGoogle, type TokenPlan } from "./google-fake";

// Sync every minute, criteria 2 to 4, and the demo of criterion 6: a Google
// access token is used again until five minutes before the end of the
// expires_in Google gave, a sign-in replaces the one kept, and a 401 asks for a
// new one before anyone is marked as having to sign in again; and, from fix round
// 1, someone Google refused is asked for at most every 10 minutes and marked
// once. Google is a fetch stub (google-fake.ts) and the clock is a fake Date;
// nothing leaves the process. After every test, no log line, row or answer may
// hold an access token.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const SECRET = "g".repeat(40);
const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
const CLIENT_ID = "test-client.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = SECRET;
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
delete process.env.DEMO_MODE;
delete process.env.EXPOSURE;
delete process.env.APP_URL;
delete process.env.CONFIG_PATH;

const { NextRequest } = await import("next/server");
const db = await import("@/lib/server/db");
const secrets = await import("@/lib/server/secrets");
const sync = await import("@/lib/server/sync");
const viewer = await import("@/lib/server/viewer");
const callbackRoute = await import("@/app/auth/google/callback/route");
const meRoute = await import("@/app/api/me/route");
const meSyncRoute = await import("@/app/api/me/sync/route");
const syncRoute = await import("@/app/api/sync/route");
const statusRoute = await import("@/app/api/status/route");
const availabilityRoute = await import("@/app/api/availability/route");

const MIN = 60_000;
const DAY = 86_400_000;
const realSetTimeout = globalThis.setTimeout;

let google: FakeGoogle;
/** Answers a test holds: released after it whatever happened, so no round is left waiting for the next test. */
const holds: (() => void)[] = [];
function held() {
  const h = holding();
  holds.push(() => {
    if (h.asked()) h.release(plans.serverError());
  });
  return h;
}
function deferred<T>(fallback: T) {
  const d = waiting<T>();
  holds.push(() => d.resolve(fallback));
  return d;
}
let lines: string[] = [];
/** Every answer a route gave, with its headers. */
let answers: string[] = [];
/** The start of the current test on the fake clock: later in every test, so cooldowns never carry over. */
let T = Math.floor(Date.now() / DAY) * DAY + 10 * 3_600_000;

beforeEach(() => {
  db.resetAll();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.google-tokens")];
  jar.session = undefined;
  answers = [];
  lines = captureConsole();
  google = fakeGoogle();
  T += 3 * DAY;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T);
});
afterEach(async () => {
  for (const release of holds.splice(0)) {
    try {
      release();
    } catch {}
  }
  await sync.syncNow();
  // Criterion 2: no log line, row or answer holds an access token, whatever the test did.
  const handedOut = [...google.issued.keys()];
  const rows = (db.db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) =>
    JSON.stringify(db.db().prepare(`SELECT * FROM ${t.name}`).all()),
  );
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.CONFIG_YAML = CONFIG;
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
  process.env.SESSION_SECRET = SECRET;
  delete process.env.DEMO_MODE;
  for (const [what, texts] of [
    ["log line", lines],
    ["row", rows],
    ["answer", answers],
  ] as const) {
    for (const text of texts) {
      expect(text, `an access token in a ${what}`).not.toContain(TOKEN_MARK);
      for (const token of handedOut) expect(text, `an access token in a ${what}`).not.toContain(token);
    }
  }
});

// ---------------------------------------------------------------------------

type Person = { id: string; sub: string; email: string; name: string; refreshToken: string };
let n = 0;

/** Someone who signed in with Google before: a refresh token Google takes, and their calendars there (by default one, their primary). */
function person(calendars?: Account["calendars"]): Person {
  n++;
  const p = { sub: `g-${n}`, email: `p${n}@example.com`, name: `Person ${n}`, refreshToken: `1//refresh-${n}` };
  google.accounts.set(p.refreshToken, { email: p.email, calendars: calendars ?? [{ id: p.email }] });
  const { user } = db.upsertGoogleUser({
    sub: p.sub,
    email: p.email,
    name: p.name,
    timezone: "UTC",
    refreshToken: secrets.encrypt(p.refreshToken),
    calendarAccess: true,
  });
  return { ...p, id: user.id };
}

/** A sync round (what the scheduler runs) at `at` on the fake clock. */
async function roundAt(at: number): Promise<void> {
  vi.setSystemTime(at);
  await sync.syncNow();
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; !done(); i++) {
    if (i > 600) throw new Error(`test: waited too long for ${what}`);
    await new Promise((r) => realSetTimeout(r, 5));
  }
}
const pause = () => new Promise((r) => realSetTimeout(r, 30));

const calendar = (p: Person, id: string) => db.listCalendars(p.id).find((c) => c.calendar_id === id);
const user = (p: Person) => db.getUser(p.id)!;
const cookieOf = (p: Person) => secrets.sessionValue(user(p)).value;
/** The tokens the API requests after request `since` carried, in order. */
const usedSince = (since = 0) => google.api(since).map((c) => c.token);
/** The access token each token request of `p` got, in order. */
const tokensOf = (p: Person) => google.refreshes(p.refreshToken).map((c) => google.tokenFor(c));

async function record(res: Response): Promise<Response> {
  const text = await res.clone().text();
  answers.push(text, JSON.stringify([...res.headers.entries()]));
  return res;
}

let codes = 0;
/**
 * `p` signs in again through Google's callback; the token endpoint answers the
 * code with a new access token, `refreshToken` or none (Google keeps the one it
 * gave before), and expires_in `expiresIn` (null: left out). Returns the seq of
 * that answer: tokens asked for from then on are newer than the sign-in's.
 */
async function signInAgain(p: Person, opts: { refreshToken: string | null; expiresIn: unknown }): Promise<{ seq: number; token: string; cookie: string }> {
  const code = `code-${++codes}`;
  google.signIns.set(code, { sub: p.sub, email: p.email, name: p.name, ...opts });
  const res = await record(
    await callbackRoute.GET(
      new NextRequest(`http://localhost/auth/google/callback?code=${code}&state=st-${codes}`, { headers: { cookie: `ekip_oauth_state=st-${codes}` } }),
    ),
  );
  expect(res.status).toBeGreaterThanOrEqual(300);
  expect(res.headers.get("location")).not.toContain("signin=");
  if (opts.refreshToken) p.refreshToken = opts.refreshToken;
  const answered = google.calls.find((c) => c.kind === "code" && c.code === code)!;
  const cookie = /ekip_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
  expect(cookie).not.toBe("");
  return { seq: answered.seq, token: google.tokenFor(answered)!, cookie };
}

/** Wait for the sync a sign-in started: their primary calendar read at the time on the clock. */
async function signInSynced(p: Person): Promise<void> {
  await until(() => calendar(p, p.email)?.last_success === Date.now(), "the sign-in's sync");
  await pause();
}

/** Every token used since request `since` is the sign-in's or one asked for after it. */
function onlySignInTokenOrNewer(since: number, signIn: { seq: number }, label: string) {
  const used = google.api(since);
  expect(used.length, label).toBeGreaterThan(0);
  for (const call of used) {
    expect(google.issued.get(call.token)?.askedSeq, `${label}: ${call.kind} request`).toBeGreaterThanOrEqual(signIn.seq);
  }
}

let configs = 0;
/** Another team config. An inline config is read again when its length changes, so each gets a comment of its own length. */
function useConfig(yaml: string) {
  process.env.CONFIG_YAML = `${yaml}# ${"x".repeat(1000 * ++configs)}\n`;
  return sync.getConfig()!;
}

// ---------------------------------------------------------------------------

describe("access tokens are used again (criterion 2)", () => {
  it("a person's first Google request gets one from their refresh token; a round one minute later asks for none and reads Google with it", async () => {
    const ayse = person();
    await roundAt(T);
    expect(google.refreshes()).toEqual([expect.objectContaining({ refreshToken: ayse.refreshToken })]);
    const [token] = tokensOf(ayse);
    expect(token).toEqual(expect.stringContaining(TOKEN_MARK));
    expect(google.api().map((c) => [c.kind, c.token])).toEqual([
      ["list", token],
      ["events", token],
    ]);
    expect(calendar(ayse, ayse.email)).toMatchObject({ last_success: T, error: null });

    const before = google.seq();
    await roundAt(T + MIN);
    expect(google.refreshes()).toHaveLength(1);
    expect(google.api(before).map((c) => [c.kind, c.token])).toEqual([
      ["list", token],
      ["events", token],
    ]);
    expect(calendar(ayse, ayse.email)).toMatchObject({ last_success: T + MIN, error: null });
    expect(user(ayse).token_error).toBeNull();
  });

  it("every round a minute apart for 50 minutes: one token request in all", async () => {
    const ayse = person();
    for (let m = 0; m <= 50; m++) await roundAt(T + m * MIN);
    expect(google.refreshes()).toHaveLength(1);
    expect(new Set(usedSince())).toEqual(new Set(tokensOf(ayse)));
    expect(google.api().filter((c) => c.kind === "list")).toHaveLength(51);
  });

  it("the owner's own syncs use it again too: Save and Refresh from Google after a round ask for no token", async () => {
    const ayse = person();
    await roundAt(T);
    const [token] = tokensOf(ayse);
    jar.session = cookieOf(ayse);
    const mine = (await (await record(await meRoute.GET())).json()) as { timezone: string; color: string; calendars: { id: string; label: string; included: boolean }[] };
    vi.setSystemTime(T + MIN);
    const saved = await record(
      await meRoute.PUT(
        new NextRequest("http://localhost/api/me", {
          method: "PUT",
          body: JSON.stringify({ team: null, timezone: mine.timezone, color: mine.color, calendars: mine.calendars.map(({ id, label, included }) => ({ id, label, included })) }),
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    expect(saved.status).toBe(200);
    vi.setSystemTime(T + 2 * MIN);
    expect((await record(await meSyncRoute.POST())).status).toBe(200);
    expect(google.refreshes()).toHaveLength(1);
    expect(google.api().map((c) => c.token)).toEqual([token, token, token, token, token, token]);
    expect(calendar(ayse, ayse.email)).toMatchObject({ last_success: T + 2 * MIN, error: null });
  });

  it("with expires_in 3600, a round 54 minutes later uses it again; one 56 minutes later asks for a new one, which the next rounds use", async () => {
    const ayse = person();
    google.next(ayse.refreshToken, plans.token(3600), plans.token(3600));
    await roundAt(T);
    await roundAt(T + 54 * MIN);
    expect(google.refreshes()).toHaveLength(1);
    const before = google.seq();
    await roundAt(T + 56 * MIN);
    expect(google.refreshes()).toHaveLength(2);
    const [first, second] = tokensOf(ayse);
    expect(second).not.toBe(first);
    expect(usedSince(before)).toEqual([second, second]);
    const after = google.seq();
    await roundAt(T + 57 * MIN);
    await roundAt(T + 100 * MIN);
    expect(google.refreshes()).toHaveLength(2);
    expect(usedSince(after)).toEqual([second, second, second, second]);
  });

  it("the turn is five minutes before the end: 54 min 59 s still uses it, 55 min 1 s doesn't", async () => {
    const ayse = person();
    await roundAt(T);
    await roundAt(T + 55 * MIN - 1000);
    expect(google.refreshes()).toHaveLength(1);
    await roundAt(T + 55 * MIN + 1000);
    expect(google.refreshes()).toHaveLength(2);
    expect(google.refreshes().map((c) => c.at)).toEqual([T, T + 55 * MIN + 1000]);
    expect(new Set(tokensOf(ayse)).size).toBe(2);
  });

  it("it's the expires_in Google gave: with 1200, 14 minutes later used again, 16 minutes later a new one", async () => {
    const ayse = person();
    google.next(ayse.refreshToken, plans.token(1200));
    await roundAt(T);
    await roundAt(T + 14 * MIN);
    expect(google.refreshes()).toHaveLength(1);
    await roundAt(T + 16 * MIN);
    expect(google.refreshes()).toHaveLength(2);
  });

  it.each([
    ["no expires_in", null],
    ["expires_in 0", 0],
    ["a negative expires_in", -60],
  ])("a token answer with %s isn't used again: the next round asks for a new one and uses it", async (_name, expiresIn) => {
    const ayse = person();
    google.next(ayse.refreshToken, plans.token(expiresIn), plans.token(expiresIn));
    await roundAt(T);
    const [first] = tokensOf(ayse);
    expect(usedSince()).toEqual([first, first]);
    const before = google.seq();
    await roundAt(T + MIN);
    expect(google.refreshes()).toHaveLength(2);
    const [, second] = tokensOf(ayse);
    expect(usedSince(before)).toEqual([second, second]);
    expect(user(ayse).token_error).toBeNull();
  });

  it("two people never share a token: each refresh token gets its own, used only for that person's calendars", async () => {
    const ayse = person();
    const burak = person([{ id: "burak@example.com" }, { id: "burak-team@group.calendar.google.com", access: "freebusy" }]);
    const cem = person();
    // Cem's token request fails this round: nobody else's token stands in.
    google.next(cem.refreshToken, plans.serverError());
    for (const at of [T, T + MIN, T + 2 * MIN]) await roundAt(at);
    db.updateCalendarChoices(burak.id, [{ id: "burak-team@group.calendar.google.com", label: "Team", included: true }]);
    await roundAt(T + 3 * MIN);

    expect(google.refreshes(ayse.refreshToken)).toHaveLength(1);
    expect(google.refreshes(burak.refreshToken)).toHaveLength(1);
    const [a] = tokensOf(ayse);
    const [b] = tokensOf(burak);
    expect(a).not.toBe(b);
    // Each one's calendars are read with their own token only, and each one's list is their own.
    const byCalendar = (id: string) => new Set(google.api().filter((c) => c.calendarId === id).map((c) => c.token));
    expect(byCalendar(ayse.email)).toEqual(new Set([a]));
    expect(byCalendar("burak@example.com")).toEqual(new Set([b]));
    expect(byCalendar("burak-team@group.calendar.google.com")).toEqual(new Set([b]));
    expect(db.listCalendars(ayse.id).map((c) => c.calendar_id)).toEqual([ayse.email]);
    expect(db.listCalendars(burak.id).map((c) => c.calendar_id)).toEqual(["burak@example.com", "burak-team@group.calendar.google.com"]);
    expect(calendar(burak, "burak-team@group.calendar.google.com")).toMatchObject({ last_success: T + 3 * MIN, error: null });
    // Cem: his own token from the round after his failed, then his only.
    const [, c] = tokensOf(cem);
    expect(byCalendar(cem.email)).toEqual(new Set([c]));
    expect(db.listCalendars(cem.id).map((x) => x.calendar_id)).toEqual([cem.email]);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("no row, log line or answer holds an access token: rounds, sign-ins, renewals, failures and every route", async () => {
    const ayse = person();
    const burak = person();
    const cem = person();
    await roundAt(T);
    const signedIn = await signInAgain(ayse, { refreshToken: null, expiresIn: 3600 });
    await signInSynced(ayse);
    // A 401 renewed, a refused refresh token, a renewal that fails, a calendar Google can't read.
    // Burak's tokens are turned down (20 times at most, so a renewal without end can't hang the test).
    let burakTurnedDown = 0;
    google.onApi = (call) => {
      if (call.token === signedIn.token && call.kind === "events") return unauthorized();
      if (google.issued.get(call.token)?.email === burak.email && burakTurnedDown++ < 20) return unauthorized();
      if (google.issued.get(call.token)?.email === cem.email && call.kind === "events") return new Response("oops", { status: 500 });
      return undefined;
    };
    google.next(burak.refreshToken, plans.invalidGrant());
    await roundAt(T + MIN);
    expect(user(burak).token_error).toEqual(expect.any(String));

    jar.session = secrets.sessionValue(user(ayse)).value;
    const me = (await record(await meRoute.GET())).clone();
    const mine = (await me.json()) as { timezone: string; color: string; calendars: { id: string; label: string; included: boolean }[] };
    vi.setSystemTime(T + 2 * MIN);
    await record(
      await meRoute.PUT(
        new NextRequest("http://localhost/api/me", {
          method: "PUT",
          body: JSON.stringify({ team: null, timezone: mine.timezone, color: mine.color, calendars: mine.calendars.map(({ id, label, included }) => ({ id, label, included })) }),
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.setSystemTime(T + 3 * MIN);
    await record(await meSyncRoute.POST());
    vi.setSystemTime(T + 4 * MIN);
    expect((await record(await syncRoute.POST())).status).toBe(202);
    await sync.syncNow();
    await record(await statusRoute.GET());
    const today = new Date(T).toISOString().slice(0, 10);
    await record(await availabilityRoute.GET(new NextRequest(`http://localhost/api/availability?start=${today}&days=7&tz=UTC`)));

    // The checks after every test look for them; here, that there was something to find.
    expect(google.issued.size).toBeGreaterThanOrEqual(4);
    expect(answers.length).toBeGreaterThan(10);
    expect(lines.some((l) => l.includes("google access lost"))).toBe(true);
    expect(lines.some((l) => l.includes("calendar failed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("a sign-in replaces the kept token (criterion 3)", () => {
  it.each([
    ["without a new refresh token (the stored one is kept)", null],
    ["with a new refresh token", "1//refresh-new"],
  ])("%s: the sign-in's own sync and the next rounds use its token, never the one kept from before", async (_name, newRefresh) => {
    const ayse = person();
    await roundAt(T);
    const [old] = tokensOf(ayse);

    vi.setSystemTime(T + MIN);
    const signedIn = await signInAgain(ayse, { refreshToken: newRefresh && `${newRefresh}-${n}`, expiresIn: 3600 });
    await signInSynced(ayse);
    onlySignInTokenOrNewer(signedIn.seq, signedIn, "the sign-in's own sync");
    expect(usedSince(signedIn.seq)).not.toContain(old);

    await roundAt(T + 2 * MIN);
    await roundAt(T + 30 * MIN);
    onlySignInTokenOrNewer(signedIn.seq, signedIn, "the rounds after it");
    expect(usedSince(signedIn.seq)).not.toContain(old);
    expect(user(ayse).token_error).toBeNull();
  });

  it("a sign-in whose answer has no expires_in: the next request asks for a newer token rather than using the one kept from before", async () => {
    const ayse = person();
    await roundAt(T);
    const [old] = tokensOf(ayse);
    vi.setSystemTime(T + MIN);
    const signedIn = await signInAgain(ayse, { refreshToken: null, expiresIn: null });
    await signInSynced(ayse);
    await roundAt(T + 2 * MIN);
    onlySignInTokenOrNewer(signedIn.seq, signedIn, "after the sign-in");
    expect(usedSince(signedIn.seq)).not.toContain(old);
  });

  it("a token request in flight across a sign-in: what it brings back is neither used after the sign-in nor kept", async () => {
    const ayse = person();
    const inFlight = held();
    google.next(ayse.refreshToken, inFlight.plan);
    const round = sync.syncNow();
    await until(inFlight.asked, "the round's token request");

    const signedIn = await signInAgain(ayse, { refreshToken: null, expiresIn: 3600 });
    await signInSynced(ayse);
    // Now the round's token request answers, with a token asked for before the sign-in.
    inFlight.release(plans.token(3600));
    await round;
    const [early] = tokensOf(ayse);
    expect(early).toEqual(expect.stringContaining(TOKEN_MARK));
    onlySignInTokenOrNewer(signedIn.seq, signedIn, "the round, after the sign-in");
    expect(usedSince(signedIn.seq)).not.toContain(early);

    await roundAt(T + MIN);
    await roundAt(T + 20 * MIN);
    onlySignInTokenOrNewer(signedIn.seq, signedIn, "the next rounds");
    expect(usedSince(signedIn.seq)).not.toContain(early);
  });

  it("a token request in flight across a sign-in that brings a new refresh token: the rounds after it never use what it brings back", async () => {
    const ayse = person();
    const inFlight = held();
    google.next(ayse.refreshToken, inFlight.plan);
    const round = sync.syncNow();
    await until(inFlight.asked, "the round's token request");
    const signedIn = await signInAgain(ayse, { refreshToken: `1//refresh-new-${n}`, expiresIn: 3600 });
    await signInSynced(ayse);
    inFlight.release(plans.token(3600));
    await round;
    const [early] = google.refreshes().map((c) => google.tokenFor(c));
    const since = google.seq();
    await roundAt(T + MIN);
    await roundAt(T + 20 * MIN);
    onlySignInTokenOrNewer(since, signedIn, "the next rounds");
    expect(usedSince(since)).not.toContain(early);
  });
});

// ---------------------------------------------------------------------------

describe("a 401 asks for a new token before anyone is marked (criterion 4)", () => {
  /** Ayşe, read once at T with token `first`; her calendars as given. */
  async function readOnce(calendars?: Account["calendars"]) {
    const ayse = person(calendars);
    await roundAt(T);
    const [first] = tokensOf(ayse);
    expect(first).toEqual(expect.stringContaining(TOKEN_MARK));
    return { ayse, first: first!, cookie: cookieOf(ayse), version: user(ayse).session_version };
  }
  const SHARED = "team-free-busy@group.calendar.google.com";
  /** Google turns `token` down on requests of `kind` (any kind when null). */
  const refuse = (token: string, kind: ApiCall["kind"] | null) => {
    google.onApi = (call) => (call.token === token && (kind === null || call.kind === kind) ? unauthorized() : undefined);
  };

  /**
   * Google turns down every access token, those a renewal brings too, until
   * `before` is set: then only tokens asked for before it. It gives up after 20
   * refusals, so a renewal without end shows up as a count, not a hang.
   */
  function turnDownEveryToken() {
    const turnDown = { before: Number.POSITIVE_INFINITY, times: 0, tokens: new Set<string>() };
    google.onApi = (call) => {
      if ((google.issued.get(call.token)?.askedSeq ?? 0) >= turnDown.before || turnDown.times >= 20) return undefined;
      turnDown.times++;
      turnDown.tokens.add(call.token);
      return unauthorized();
    };
    return turnDown;
  }

  it.each(["list", "events", "freebusy"] as const)(
    "a 401 on the %s request: the kept token is dropped and a new one asked for, the read done with it; nobody marked; later rounds use it",
    async (kind) => {
      const { ayse, first, cookie, version } = await readOnce();
      if (kind === "freebusy") {
        // A calendar shared with her as free/busy only, ticked.
        google.accounts.set(ayse.refreshToken, { email: ayse.email, calendars: [{ id: ayse.email }, { id: SHARED, access: "freebusy" }] });
        await roundAt(T + MIN / 2);
        db.updateCalendarChoices(ayse.id, [{ id: SHARED, label: "Team", included: true }]);
      }
      refuse(first, kind);
      const before = google.seq();
      await roundAt(T + MIN);

      expect(google.refreshes()).toHaveLength(2);
      const [, second] = tokensOf(ayse);
      const calls = google.api(before);
      const turnedDown = calls.findIndex((c) => c.kind === kind && c.token === first);
      expect(turnedDown, "the request Google turned down").toBeGreaterThanOrEqual(0);
      expect(calls.slice(turnedDown + 1).some((c) => c.kind === kind && c.token === second), "read again with the new token").toBe(true);
      expect(calls.slice(turnedDown + 1).map((c) => c.token)).not.toContain(first);
      const read = kind === "freebusy" ? SHARED : ayse.email;
      expect(calendar(ayse, read)).toMatchObject({ last_success: T + MIN, error: null });

      // Nobody marked: no token error, the same sessions.
      expect(user(ayse).token_error).toBeNull();
      expect(user(ayse).session_version).toBe(version);
      expect(viewer.userForSession(cookie)?.id).toBe(ayse.id);
      expect(sync.getStatus().signInAgain).toEqual([]);

      const after = google.seq();
      await roundAt(T + 2 * MIN);
      expect(google.refreshes()).toHaveLength(2);
      expect(new Set(usedSince(after))).toEqual(new Set([second]));
      expect(user(ayse).token_error).toBeNull();
    },
  );

  it.each(["list", "events"] as const)(
    "Google refuses the refresh token when asked again after a 401 on the %s request (invalid_grant): marked, sessions ended, as today",
    async (kind) => {
      const { ayse, first, cookie, version } = await readOnce();
      refuse(first, kind);
      google.next(ayse.refreshToken, plans.invalidGrant());
      await roundAt(T + MIN);
      expect(google.refreshes()).toHaveLength(2);
      expect(user(ayse).token_error).toEqual(expect.any(String));
      expect(viewer.userForSession(cookie)).toBeNull();
      expect(user(ayse).session_version).toBe(version + 1);
      expect(sync.getStatus().signInAgain.map((e) => e.personId)).toEqual([ayse.id]);
    },
  );

  it.each([
    ["no connection", plans.noConnection()],
    ["a 5xx", plans.serverError()],
    ["a timeout", plans.timeout()],
    ["a 401 without invalid_grant", plans.unauthorized()],
  ] as [string, TokenPlan][])(
    "a renewal after a 401 that fails otherwise (%s) marks nobody; the next round asks for a new token rather than using the turned-down one",
    async (_name, failing) => {
      const { ayse, first, cookie, version } = await readOnce();
      refuse(first, null);
      google.next(ayse.refreshToken, failing);
      await roundAt(T + MIN);
      expect(google.refreshes()).toHaveLength(2);
      expect(user(ayse).token_error).toBeNull();
      expect(user(ayse).session_version).toBe(version);
      expect(viewer.userForSession(cookie)?.id).toBe(ayse.id);

      const before = google.seq();
      await roundAt(T + 2 * MIN);
      expect(google.refreshes()).toHaveLength(3);
      const [, , third] = tokensOf(ayse);
      expect(usedSince(before)).toEqual([third, third]);
      expect(calendar(ayse, ayse.email)).toMatchObject({ last_success: T + 2 * MIN, error: null });
      expect(user(ayse).token_error).toBeNull();
    },
  );

  it("a second 401 right after the renewal: the round ends without asking on and on, and nobody is marked", async () => {
    const { ayse, cookie, version } = await readOnce();
    const turnDown = turnDownEveryToken();
    await roundAt(T + MIN);
    const asked = google.refreshes().length - 1;
    expect(asked, "token requests in the round").toBeGreaterThanOrEqual(1);
    expect(asked, "token requests in the round").toBeLessThanOrEqual(2);
    expect(user(ayse).token_error).toBeNull();
    expect(user(ayse).session_version).toBe(version);
    expect(viewer.userForSession(cookie)?.id).toBe(ayse.id);

    // Google takes new tokens again: the next round reads with one.
    turnDown.before = google.seq();
    await roundAt(T + 2 * MIN);
    expect(calendar(ayse, ayse.email)).toMatchObject({ last_success: T + 2 * MIN, error: null });
    expect(user(ayse).token_error).toBeNull();
  });

  it("a token Google turned down with a 401 isn't used again, also when it's the one a renewal just brought", async () => {
    const { ayse } = await readOnce();
    const turnDown = turnDownEveryToken();
    await roundAt(T + MIN);
    // The kept token and the one the renewal brought.
    const turnedDown = new Set(turnDown.tokens);
    expect(turnedDown.size).toBeGreaterThanOrEqual(2);

    turnDown.before = google.seq();
    const before = google.seq();
    await roundAt(T + 2 * MIN);
    for (const token of usedSince(before)) expect(turnedDown.has(token), "a token Google answered 401 to, used again").toBe(false);
    expect(calendar(ayse, ayse.email)).toMatchObject({ last_success: T + 2 * MIN, error: null });
  });

  it("a sign-in's token kept while the renewal's token waited for its 401 isn't dropped by that 401: the next round uses it and asks for no token", async () => {
    const { ayse, first } = await readOnce();
    const start = google.seq();
    const late = deferred<Response>(unauthorized());
    let renewed: string | null = null;
    google.onApi = (call) => {
      if (call.token === first) return unauthorized();
      // The first request with the token the renewal brought: Google answers it late, with a 401.
      if (renewed === null && (google.issued.get(call.token)?.askedSeq ?? 0) > start) {
        renewed = call.token;
        return late.promise;
      }
      return undefined;
    };
    const round = roundAt(T + MIN);
    await until(() => renewed !== null, "the request with the renewed token");
    const signedIn = await signInAgain(ayse, { refreshToken: null, expiresIn: 3600 });
    await signInSynced(ayse);
    late.resolve(unauthorized());
    await round;
    expect(tokensOf(ayse)).toEqual([first, renewed]);

    const before = google.seq();
    await roundAt(T + 2 * MIN);
    expect(google.refreshes(), "token requests").toHaveLength(2);
    expect(usedSince(before)).toEqual([signedIn.token, signedIn.token]);
    expect(user(ayse).token_error).toBeNull();
  });

  it("a refresh token Google refuses at the very start (invalid_grant): marked, sessions ended, Google asked once, as today", async () => {
    const ayse = person();
    const cookie = cookieOf(ayse);
    const version = user(ayse).session_version;
    google.next(ayse.refreshToken, plans.invalidGrant());
    await roundAt(T);
    expect(google.refreshes()).toHaveLength(1);
    expect(google.api()).toEqual([]);
    expect(user(ayse).token_error).toEqual(expect.any(String));
    expect(user(ayse).session_version).toBe(version + 1);
    expect(viewer.userForSession(cookie)).toBeNull();
  });

  it.each([
    ["no connection", plans.noConnection()],
    ["a 5xx", plans.serverError()],
    ["a timeout", plans.timeout()],
    ["a 401 without invalid_grant", plans.unauthorized()],
  ] as [string, TokenPlan][])("a first token request that fails otherwise (%s) marks nobody, as today", async (_name, failing) => {
    const ayse = person();
    const cookie = cookieOf(ayse);
    google.next(ayse.refreshToken, failing);
    await roundAt(T);
    expect(google.refreshes()).toHaveLength(1);
    expect(user(ayse).token_error).toBeNull();
    expect(viewer.userForSession(cookie)?.id).toBe(ayse.id);
  });

  describe("a sync that started before the person signed in again marks nobody, as today", () => {
    it("its 401 answers after they signed in again", async () => {
      const { ayse, first } = await readOnce();
      const old = ayse.refreshToken;
      const answer = deferred<Response>(unauthorized());
      google.onApi = (call) => (call.token === first ? answer.promise : undefined);
      google.next(old, plans.invalidGrant(), plans.invalidGrant());
      const round = roundAt(T + MIN);
      await until(() => google.api().some((c) => c.token === first && c.at === T + MIN), "the round's list request");
      const signedIn = await signInAgain(ayse, { refreshToken: `1//refresh-new-${n}`, expiresIn: 3600 });
      await signInSynced(ayse);
      const version = user(ayse).session_version;
      answer.resolve(unauthorized());
      await round;
      expect(user(ayse).token_error).toBeNull();
      expect(user(ayse).session_version).toBe(version);
      expect(viewer.userForSession(signedIn.cookie)?.id).toBe(ayse.id);
    });

    it("its renewal is refused (invalid_grant) after they signed in again", async () => {
      const { ayse, first } = await readOnce();
      const old = ayse.refreshToken;
      refuse(first, null);
      const renewal = held();
      google.next(old, renewal.plan);
      const round = roundAt(T + MIN);
      await until(renewal.asked, "the renewal");
      const signedIn = await signInAgain(ayse, { refreshToken: `1//refresh-new-${n}`, expiresIn: 3600 });
      await signInSynced(ayse);
      const version = user(ayse).session_version;
      renewal.release(plans.invalidGrant());
      await round;
      expect(user(ayse).token_error).toBeNull();
      expect(user(ayse).session_version).toBe(version);
      expect(viewer.userForSession(signedIn.cookie)?.id).toBe(ayse.id);
    });

    it("its first token request is refused (invalid_grant) after they signed in again", async () => {
      const ayse = person();
      const old = ayse.refreshToken;
      const first = held();
      google.next(old, first.plan);
      const round = roundAt(T);
      await until(first.asked, "the round's token request");
      const signedIn = await signInAgain(ayse, { refreshToken: `1//refresh-new-${n}`, expiresIn: 3600 });
      await signInSynced(ayse);
      const version = user(ayse).session_version;
      first.release(plans.invalidGrant());
      await round;
      expect(user(ayse).token_error).toBeNull();
      expect(user(ayse).session_version).toBe(version);
      expect(viewer.userForSession(signedIn.cookie)?.id).toBe(ayse.id);
    });
  });
});

// ---------------------------------------------------------------------------

// Fix round 1, item 3: someone whose refresh token Google refused (they left,
// their account suspended) was asked for a token by every round, now every
// minute by default, each time ending their sessions again and logging "google
// access lost". The approved fix: rounds ask for someone marked at most every 10
// minutes, and the first round from 10 minutes after Google's last refusal asks
// again, so access that comes back is noticed as at the old default; marking
// (token_error, the end of their sessions, the log line) happens once. With
// refresh_minutes 10 or more, rounds ask as today. A sign-in ends the wait.
describe("someone Google refused: rounds ask for them at most every 10 minutes and mark them once (fix round 1, item 3)", () => {
  /** "google access lost" lines about `p`. */
  const lost = (p: Person) => lines.filter((l) => l.includes('"msg":"google access lost"') && l.includes(`"user":"${p.id}"`)).length;
  /** When token requests asked for `p`'s refresh token, in minutes from T. */
  const askedAt = (p: Person) => google.refreshes(p.refreshToken).map((c) => (c.at - T) / MIN);
  /** Calendar API requests made with a token handed out to `p`, after request `since`. */
  const readsOf = (p: Person, since = 0) => google.api(since).filter((c) => google.issued.get(c.token)?.email === p.email);
  /** Every minute from `from` to `to` minutes after T, both included. */
  const minutes = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => T + (from + i) * MIN);
  /** A round at each of these times, in order. */
  async function rounds(at: number[]): Promise<number[]> {
    const sorted = [...at].sort((a, b) => a - b);
    for (const t of sorted) await roundAt(t);
    return sorted;
  }
  /** The main page's Refresh (POST /api/sync) at `at`, run to its end. */
  async function refreshAt(at: number): Promise<void> {
    vi.setSystemTime(at);
    expect((await record(await syncRoute.POST())).status).toBe(202);
    await sync.syncNow();
  }
  /**
   * `p` left and their account was suspended: Google refuses their refresh
   * token (invalid_grant) and turns down the access tokens it gave them. With
   * `tokensWork`, access tokens it hands out (a sign-in's) still open their
   * calendars: only the refresh token is refused. Returns their account, to
   * give it back.
   */
  function suspend(p: Person, tokensWork = false): Account {
    const account = google.accounts.get(p.refreshToken)!;
    google.accounts.delete(p.refreshToken);
    if (tokensWork) google.accounts.set(`by-email:${p.email}`, account);
    return account;
  }

  it("the finding: marked already (as after a restart), no refresh_minutes, rounds a minute apart for half an hour ask Google for him at T, T+10 and T+20 only, end no session and log nothing again; he stays marked; the others are read every round", async () => {
    const ayse = person();
    const burak = person();
    await roundAt(T - 60 * MIN);
    const cookie = cookieOf(burak);
    // He left: Google refuses his refresh token. A server that has restarted since marked him.
    suspend(burak);
    db.setTokenError(burak.id, "Token has been expired or revoked.");
    db.bumpSessionVersion(burak.id);
    const version = user(burak).session_version;

    const times = await rounds([...minutes(0, 29), T + 10 * MIN - 1, T + 20 * MIN - 1]);
    expect(askedAt(burak), "token requests for him, minutes from T").toEqual([-60, 0, 10, 20]);
    expect(user(burak).session_version, "his sessions ended again").toBe(version);
    expect(lost(burak), '"google access lost" lines').toBe(0);
    expect(user(burak).token_error).toEqual(expect.any(String));
    expect(viewer.userForSession(cookie)).toBeNull();
    expect(sync.getStatus().signInAgain.map((e) => e.personId)).toEqual([burak.id]);
    expect(readsOf(ayse).filter((c) => c.kind === "list").map((c) => c.at)).toEqual([T - 60 * MIN, ...times]);
    expect(user(ayse).token_error).toBeNull();
  });

  it("marked in this process, after a 401 whose renewal Google refuses: his sessions end and it's logged once; the rounds before 10 minutes after Google's refusal leave him alone, the first from then asks again, and so on", async () => {
    const ayse = person();
    const burak = person();
    await roundAt(T);
    const cookie = cookieOf(burak);
    const version = user(burak).session_version;
    suspend(burak);

    const times = await rounds([...minutes(1, 21), T + 11 * MIN - 1, T + 21 * MIN - 1]);
    expect(askedAt(burak), "token requests for him, minutes from T").toEqual([0, 1, 11, 21]);
    expect(user(burak).token_error).toEqual(expect.any(String));
    expect(user(burak).session_version).toBe(version + 1);
    expect(viewer.userForSession(cookie)).toBeNull();
    expect(lost(burak), '"google access lost" lines').toBe(1);
    expect(sync.getStatus().signInAgain.map((e) => e.personId)).toEqual([burak.id]);
    // After the 401 at T+1, no request with a token of his.
    expect(readsOf(burak).filter((c) => c.at > T + MIN)).toEqual([]);
    expect(readsOf(ayse).filter((c) => c.kind === "list").map((c) => c.at)).toEqual([T, ...times]);
  });

  it("Google gives his access back (an account restored): the first round from 10 minutes after the refusal reads him and clears the mark, and later rounds use the token it got", async () => {
    const burak = person();
    await roundAt(T);
    const cookie = cookieOf(burak);
    const account = suspend(burak);
    await roundAt(T + MIN);
    expect(user(burak).token_error).toEqual(expect.any(String));

    // Restored three minutes later.
    google.accounts.set(burak.refreshToken, account);
    await rounds([...minutes(4, 10), T + 11 * MIN - 1]);
    expect(askedAt(burak)).toEqual([0, 1]);
    expect(user(burak).token_error).toEqual(expect.any(String));
    await roundAt(T + 11 * MIN);
    expect(askedAt(burak)).toEqual([0, 1, 11]);
    expect(user(burak).token_error).toBeNull();
    expect(calendar(burak, burak.email)).toMatchObject({ last_success: T + 11 * MIN, error: null });

    const [, , back] = tokensOf(burak);
    expect(back).toEqual(expect.stringContaining(TOKEN_MARK));
    const before = google.seq();
    await rounds([T + 12 * MIN, T + 13 * MIN]);
    expect(askedAt(burak)).toEqual([0, 1, 11]);
    expect(usedSince(before)).toEqual([back, back, back, back]);
    // As before: his sessions stay ended until he signs in.
    expect(viewer.userForSession(cookie)).toBeNull();
    expect(lost(burak)).toBe(1);
  });

  it("the main page's Refresh (POST /api/sync) is a round: inside the 10 minutes it leaves him alone too, while it reads everyone else", async () => {
    const ayse = person();
    const burak = person();
    suspend(burak);
    await roundAt(T);
    expect(user(burak).token_error).toEqual(expect.any(String));

    const refreshes = minutes(1, 10);
    for (const at of refreshes) await refreshAt(at);
    expect(askedAt(burak), "token requests for him, minutes from T").toEqual([0, 10]);
    expect(readsOf(ayse).filter((c) => c.kind === "list").map((c) => c.at)).toEqual([T, ...refreshes]);
    expect(lost(burak)).toBe(1);
  });

  it("with refresh_minutes 9, rounds 9 minutes apart ask for him every other round: never twice within 10 minutes", async () => {
    expect(useConfig("timezone: UTC\nhorizon_days: 30\nrefresh_minutes: 9\n").refreshMinutes).toBe(9);
    const burak = person();
    const version = user(burak).session_version;
    suspend(burak);
    await rounds([0, 9, 18, 27, 36].map((m) => T + m * MIN));
    expect(askedAt(burak), "token requests for him, minutes from T").toEqual([0, 18, 36]);
    expect(user(burak).session_version).toBe(version + 1);
    expect(lost(burak)).toBe(1);
  });

  it.each([10, 60])(
    "with refresh_minutes %i, every round asks for him, as today, the main page's Refresh between rounds too; he's marked once",
    async (every) => {
      expect(useConfig(`timezone: UTC\nhorizon_days: 30\nrefresh_minutes: ${every}\n`).refreshMinutes).toBe(every);
      const burak = person();
      const cookie = cookieOf(burak);
      const version = user(burak).session_version;
      suspend(burak);
      await rounds([T, T + every * MIN, T + 2 * every * MIN]);
      await refreshAt(T + (2 * every + 5) * MIN);
      expect(askedAt(burak), "token requests for him, minutes from T").toEqual([0, every, 2 * every, 2 * every + 5]);
      expect(user(burak).token_error).toEqual(expect.any(String));
      expect(viewer.userForSession(cookie)).toBeNull();
      expect(user(burak).session_version).toBe(version + 1);
      expect(lost(burak)).toBe(1);
    },
  );

  it.each([
    ["with a new refresh token", true],
    ["without one (Google keeps the one it gave before, which works again)", false],
  ])("a sign-in ends the wait at once, %s: the next round reads his calendars", async (_name, newRefresh) => {
    const burak = person();
    await roundAt(T);
    const account = suspend(burak);
    await roundAt(T + MIN);
    expect(user(burak).token_error).toEqual(expect.any(String));

    vi.setSystemTime(T + 2 * MIN);
    if (!newRefresh) google.accounts.set(burak.refreshToken, account);
    const signedIn = await signInAgain(burak, { refreshToken: newRefresh ? `1//refresh-back-${n}` : null, expiresIn: 3600 });
    await signInSynced(burak);
    expect(user(burak).token_error).toBeNull();

    const before = google.seq();
    await roundAt(T + 3 * MIN);
    expect(readsOf(burak, before).map((c) => c.kind)).toEqual(["list", "events"]);
    onlySignInTokenOrNewer(before, signedIn, "the round after the sign-in");
    expect(calendar(burak, burak.email)).toMatchObject({ last_success: T + 3 * MIN, error: null });
    expect(user(burak).token_error).toBeNull();
    expect(viewer.userForSession(signedIn.cookie)?.id).toBe(burak.id);
  });

  it("a round from before a sign-in that brought no new refresh token, refused after it: he's marked again and the new session ended, as before", async () => {
    const burak = person();
    suspend(burak, true);
    await roundAt(T);
    expect(user(burak).token_error).toEqual(expect.any(String));

    // The wait is over: the round at T+10 asks again, and Google is slow to answer.
    const asking = held();
    google.next(burak.refreshToken, asking.plan);
    const round = roundAt(T + 10 * MIN);
    await until(asking.asked, "the round's token request");
    const signedIn = await signInAgain(burak, { refreshToken: null, expiresIn: 3600 });
    await signInSynced(burak);
    expect(user(burak).token_error).toBeNull();
    expect(viewer.userForSession(signedIn.cookie)?.id).toBe(burak.id);
    const version = user(burak).session_version;

    asking.release(plans.invalidGrant());
    await round;
    expect(user(burak).token_error).toEqual(expect.any(String));
    expect(user(burak).session_version).toBe(version + 1);
    expect(viewer.userForSession(signedIn.cookie)).toBeNull();
    expect(lost(burak)).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("Remove me (criterion 6: nothing else changes)", () => {
  it("still gives Google access back and forgets the person, with a token kept for them", async () => {
    const ayse = person();
    await roundAt(T);
    jar.session = cookieOf(ayse);
    vi.setSystemTime(T + MIN);
    const res = await record(await meRoute.DELETE());
    expect(res.status).toBe(200);
    expect(db.getUser(ayse.id)).toBeNull();
    expect(google.calls.filter((c) => c.kind === "revoke").map((c) => ("token" in c ? c.token : null))).toEqual([ayse.refreshToken]);
    // Nobody is left to read: the next round asks Google for nothing.
    const before = google.seq();
    await roundAt(T + 2 * MIN);
    expect(google.calls.filter((c) => c.seq > before)).toEqual([]);
  });
});

describe("the demo (criterion 6)", () => {
  it("makes no Google request, in a round or in syncOne, as before", async () => {
    process.env.DEMO_MODE = "true";
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const ayse = person();
    await roundAt(T);
    await sync.syncOne(ayse.id);
    await roundAt(T + MIN);
    await sync.syncOne(ayse.id);
    expect(google.calls).toEqual([]);
  });
});
