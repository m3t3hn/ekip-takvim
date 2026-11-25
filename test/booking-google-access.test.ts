import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyBookingLinks } from "@/lib/types";
import { at } from "./booking-reference";
import { LINK, LINK_FULL, TAKEN, bookingApp, type LinkBody } from "./booking-helpers";
import { EVENTS_SCOPE, READ_SCOPE, googleSide, inTheDemo, withGoogle } from "./booking-google-helpers";
import { fakeGoogle, jsonResponse } from "./google-fake";
import { captureConsole } from "./link-helpers";

// Booking links, part 2 (run 2026-11-19-ekip-booking-2): write access is
// opt-in per host.
// - Criterion 1: authUrl's booking flag, and GET /auth/google?booking=1.
// - Criterion 2: the sign-in callback storing booking_access from the token's
//   scope, and where the person lands.
// - Criterion 3: bookingAccess in the host's answers, the demo giving
//   everyone access, and the two rules that offer no times.
// Google is a stubbed fetch.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "a".repeat(40);
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.APP_URL = "https://cal.example.com";
delete process.env.EXPOSURE;
withGoogle();

const app = await bookingApp(jar);
const { db, NextRequest } = app;
const fake = fakeGoogle();
const google = googleSide(app, fake);
const googleLib = await import("@/lib/server/google");
const googleRoute = await import("@/app/auth/google/route");
const callbackRoute = await import("@/app/auth/google/callback/route");
const demoRoute = await import("@/app/auth/demo/route");
const demoLib = await import("@/lib/server/demo");

const ist = (d: number, h: number, m = 0) => at("Europe/Istanbul", 2026, 11, d, h, m);
const NOW = ist(18, 9);
const MIN = 60_000;
const HOUR = 60 * MIN;
const START = ist(19, 10, 30);
const GUEST = { name: "Access Guest", email: "access.guest@guests.example.org" };

const setNow = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};

let lines: string[] = [];

beforeAll(() => {
  lines = captureConsole();
});
beforeEach(() => {
  db.resetAll();
  app.signOut();
  setNow(NOW);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.booking-limits")];
  fake.reset();
  fake.install();
  withGoogle();
});
afterEach(async () => {
  // A sign-in starts a sync in the background: let it finish on the fake first.
  await fake.idle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
  process.env.CONFIG_YAML = CONFIG;
  withGoogle();
  expect(fake.problems).toEqual([]);
  expect(lines.join("\n")).not.toContain("access.guest");
});

/** What authUrl gave before this branch (f1c9eec) for these inputs, read from that commit's own code. */
const BEFORE = {
  plain:
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fcal.example.com%2Fauth%2Fgoogle%2Fcallback&response_type=code&scope=openid+email+profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly&access_type=offline&prompt=consent&include_granted_scopes=true&state=st4te-Abc_123",
  domain:
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fcal.example.com%2Fauth%2Fgoogle%2Fcallback&response_type=code&scope=openid+email+profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly&access_type=offline&prompt=consent&include_granted_scopes=true&state=st4te-Abc_123&hd=example.com",
};
const ORDINARY_SCOPE = `openid email profile ${READ_SCOPE}`;
const BOOKING_SCOPE = `openid email profile ${READ_SCOPE} ${EVENTS_SCOPE}`;

describe("authUrl (criterion 1)", () => {
  const base = { origin: "https://ignored.example.net", state: "st4te-Abc_123" };

  it("with booking, asks for calendar.events on top of today's scopes, with include_granted_scopes, offline access and consent", () => {
    for (const domain of [null, "example.com"]) {
      const url = new URL(googleLib.authUrl({ ...base, domain, booking: true }));
      expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(url.searchParams.get("scope")).toBe(BOOKING_SCOPE);
      expect(url.searchParams.get("include_granted_scopes")).toBe("true");
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      // Everything else is as without it.
      const before = new URL(domain ? BEFORE.domain : BEFORE.plain).searchParams;
      const rest = (q: URLSearchParams) => [...q.entries()].filter(([k]) => k !== "scope").sort();
      expect(rest(url.searchParams)).toEqual(rest(before));
    }
  });

  it("without the flag, is the URL it was before this branch", () => {
    expect(googleLib.authUrl({ ...base, domain: null })).toBe(BEFORE.plain);
    expect(googleLib.authUrl({ ...base, domain: null, booking: false })).toBe(BEFORE.plain);
    expect(googleLib.authUrl({ ...base, domain: "example.com" })).toBe(BEFORE.domain);
    expect(googleLib.authUrl({ ...base, domain: "example.com", booking: false })).toBe(BEFORE.domain);
  });
});

/** Start a Google sign-in; Google's address, and the state cookie it set. */
function startSignIn(query: string) {
  const res = googleRoute.GET(new NextRequest(`https://cal.example.com/auth/google${query}`));
  expect(res.status).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  const url = new URL(res.headers.get("location")!);
  return { url, cookie: res.cookies.get("ekip_oauth_state")?.value };
}

describe("GET /auth/google?booking=1 (criterion 1)", () => {
  it("asks for calendar.events while BOOKING_LINKS is on", () => {
    const { url, cookie } = startSignIn("?booking=1");
    expect(url.searchParams.get("scope")).toBe(BOOKING_SCOPE);
    expect(cookie).toBe(url.searchParams.get("state"));
    // Without ?booking=1, an ordinary sign-in.
    expect(startSignIn("").url.searchParams.get("scope")).toBe(ORDINARY_SCOPE);
  });

  it.each([undefined, "", "off", "Off", "yes", "true"])("is an ordinary sign-in while BOOKING_LINKS is %j", (setting) => {
    if (setting === undefined) delete process.env.BOOKING_LINKS;
    else process.env.BOOKING_LINKS = setting;
    const { url, cookie } = startSignIn("?booking=1");
    expect(url.searchParams.get("scope")).toBe(ORDINARY_SCOPE);
    // The very address an ordinary sign-in gets, with this sign-in's state.
    const state = url.searchParams.get("state")!;
    expect(cookie).toBe(state);
    expect(url.href).toBe(BEFORE.plain.replace("state=st4te-Abc_123", `state=${encodeURIComponent(state)}`));
  });
});

describe("the sign-in callback (criterion 2)", () => {
  const PERSON = { sub: "g-callback-1", email: "callback.host@example.com", name: "Callback Host" };
  const REFRESH = "1//callback-refresh-token";
  const GOOGLE_EMAIL = "https://www.googleapis.com/auth/userinfo.email";
  const GOOGLE_PROFILE = "https://www.googleapis.com/auth/userinfo.profile";

  const idToken = (claims: object) => ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2lnbmF0dXJl"].join(".");

  /** Google answers the code with the person's tokens and the scopes this sign-in granted, as Google spells them. */
  function grants(scopes: string[]) {
    const account = fake.accounts.find((a) => a.refreshToken === REFRESH) ?? fake.account({ refreshToken: REFRESH, primary: PERSON.email });
    fake.answer.token = (call) =>
      call.form?.get("grant_type") === "authorization_code"
        ? jsonResponse(200, {
            access_token: account.accessToken,
            refresh_token: REFRESH,
            id_token: idToken({ sub: PERSON.sub, email: PERSON.email, email_verified: true, name: PERSON.name }),
            scope: ["openid", GOOGLE_EMAIL, GOOGLE_PROFILE, ...scopes].join(" "),
            token_type: "Bearer",
            expires_in: 3599,
          })
        : undefined;
  }

  /** Sign in through GET /auth/google (with `query`) and the callback; where the person lands, and their row. */
  async function signIn(query: string) {
    const { url, cookie } = startSignIn(query);
    const state = url.searchParams.get("state")!;
    expect(cookie).toBe(state);
    const res = await callbackRoute.GET(
      new NextRequest(`https://cal.example.com/auth/google/callback?code=c0de&state=${encodeURIComponent(state)}`, {
        headers: { cookie: `ekip_oauth_state=${state}` },
      }),
    );
    // The sync the sign-in starts.
    await fake.idle();
    const landing = new URL(res.headers.get("location")!);
    const user = db.listUsers().find((u) => u.google_sub === PERSON.sub);
    expect(user, `signed in (landed on ${landing.pathname}${landing.search})`).toBeTruthy();
    expect(res.cookies.get("ekip_session")?.value).toBeTruthy();
    return { landing: `${landing.pathname}${landing.search}${landing.hash}`, at: landing, user: user! };
  }

  it("stores booking_access from the token's scope at every sign-in", async () => {
    const steps: [string, string[], number][] = [
      ["?booking=1", [READ_SCOPE, EVENTS_SCOPE], 1],
      ["", [READ_SCOPE], 0],
      ["?booking=1", [READ_SCOPE, EVENTS_SCOPE], 1],
      // Granted before, it comes back with an ordinary sign-in (include_granted_scopes).
      ["", [READ_SCOPE, EVENTS_SCOPE], 1],
      ["?booking=1", [READ_SCOPE], 0],
      // A scope that only starts the same isn't calendar.events.
      ["?booking=1", [READ_SCOPE, `${EVENTS_SCOPE}.readonly`], 0],
      ["?booking=1", [EVENTS_SCOPE], 1],
      ["", [], 0],
    ];
    for (const [i, [query, scopes, expected]] of steps.entries()) {
      grants(scopes);
      const { user } = await signIn(query);
      expect(user.booking_access, `sign-in ${i + 1}: ${scopes.join(" ")}`).toBe(expected);
    }
    expect(db.listUsers()).toHaveLength(1);
  });

  // Run 2026-11-25-ekip-quick-wins-host, criterion 5: Allow access now always
  // comes back to My settings' booking links, /settings#booking, with a note
  // for how it went (test/booking-allow-access.test.ts checks the notes).
  // Ordinary sign-ins land as before.
  it("lands on My settings' booking links after a sign-in that asked for booking access, whatever was granted", async () => {
    const bookingLinks = (at: URL) => `${at.pathname}${at.hash}`;
    // Someone already here, with calendar access.
    grants([READ_SCOPE]);
    expect((await signIn("")).landing).toBe("/settings");
    grants([READ_SCOPE]);
    expect((await signIn("")).landing, "an ordinary sign-in, as before").toBe("/");
    grants([READ_SCOPE, EVENTS_SCOPE]);
    expect(bookingLinks((await signIn("?booking=1")).at)).toBe("/settings#booking");
    grants([READ_SCOPE, EVENTS_SCOPE]);
    expect((await signIn("")).landing, "an ordinary sign-in again").toBe("/");
    grants([READ_SCOPE]);
    expect(bookingLinks((await signIn("?booking=1")).at), "asked, but not granted").toBe("/settings#booking");
    // While booking links are off, ?booking=1 is an ordinary sign-in.
    process.env.BOOKING_LINKS = "off";
    grants([READ_SCOPE]);
    expect((await signIn("?booking=1")).landing).toBe("/");
  });
});

/** A host with one link (and the given access) and two bookings on it, in the current mode. */
async function hostWithBookings(link: Partial<LinkBody> = {}) {
  const { host, id } = await google.hostWithLink({ title: "First", ...link }, { name: "Answer Host" });
  const one = await google.bookIt(id, START, GUEST);
  const two = await google.bookIt(id, ist(19, 11, 30), GUEST);
  return { host, id, bookings: [String(one.row.id), String(two.row.id)] };
}

const storeAccess = (userId: string, value: 0 | 1) => db.db().prepare("UPDATE users SET booking_access = ? WHERE id = ?").run(value, userId);

describe("bookingAccess in the host's answers (criterion 3)", () => {
  it.each(["in the demo", "outside the demo"])("%s, is the stored value in every answer under /api/me/booking-links and /api/me/bookings", async (mode) => {
    if (mode === "in the demo") inTheDemo();
    const { host, id, bookings } = await hostWithBookings();
    for (const [i, value] of ([1, 0] as const).entries()) {
      storeAccess(host.id, value);
      app.signIn(host.id);
      const answers: [string, { status: number; json: unknown; text: string }][] = [];
      answers.push(["GET", await app.myLinks()]);
      const made = await app.createLink({ ...LINK, title: `Another ${i}` });
      answers.push(["POST", made]);
      const another = (made.json as MyBookingLinks).links.find((l) => l.title === `Another ${i}`)!.id;
      answers.push(["PUT", await app.updateLink(id, { ...LINK, title: "First" })]);
      answers.push(["DELETE", await app.deleteLink(another)]);
      answers.push(["cancel", await app.cancelMine(bookings[i])]);
      app.signOut();
      for (const [what, a] of answers) {
        expect(a.status, `${what}: ${a.text}`).toBe(200);
        expect((a.json as MyBookingLinks).bookingAccess, `${what} with booking_access = ${value}`).toBe(value === 1);
      }
    }
  });

  it("the demo gives every demo person booking access, and /auth/demo gives it to whoever signs in", async () => {
    inTheDemo();
    expect(demoLib.seedDemo(app.sync.getConfig()!)).toBe(true);
    const people = db.listUsers();
    expect(people.length).toBeGreaterThanOrEqual(3);
    expect(people.map((p) => [p.id, p.booking_access])).toEqual(people.map((p) => [p.id, 1]));

    // Switched off by hand, then that person signs in to the demo again.
    storeAccess(people[0].id, 0);
    app.signIn(people[0].id);
    expect(((await app.myLinks()).json as MyBookingLinks).bookingAccess).toBe(false);
    app.signOut();
    const res = demoRoute.GET(new NextRequest(`https://cal.example.com/auth/demo?as=${people[0].id}`));
    expect(res.headers.get("location")).toBeTruthy();
    expect(db.getUser(people[0].id)!.booking_access).toBe(1);

    // Someone new in the demo database starts with the column's default, until they sign in.
    db.db()
      .prepare("INSERT INTO users (id, google_sub, email, name, team, timezone, color, created_at) VALUES ('newcomer', NULL, 'newcomer@demo.example', 'Newcomer', NULL, 'Europe/Istanbul', '#123457', ?)")
      .run(Date.now());
    expect(db.getUser("newcomer")!.booking_access).toBe(0);
    demoRoute.GET(new NextRequest("https://cal.example.com/auth/demo?as=newcomer"));
    expect(db.getUser("newcomer")!.booking_access).toBe(1);
    expect(fake.calls).toEqual([]);
  });
});

describe("no times without booking access (criterion 3)", () => {
  it.each(["in the demo", "outside the demo"])("%s, a host with booking_access = 0 offers no times, and a POST answers 409", async (mode) => {
    if (mode === "in the demo") inTheDemo();
    const { host, id } = await google.hostWithLink({}, { bookingAccess: false });
    expect(db.getUser(host.id)!.booking_access).toBe(0);
    expect(await app.startsOf(id)).toEqual([]);
    const a = await app.book(id, { start: START, ...GUEST });
    expect([a.status, a.json]).toEqual([409, TAKEN]);
    expect(app.bookingRows()).toEqual([]);
    expect(fake.of("insert")).toEqual([]);
    // With access, the same time is offered.
    storeAccess(host.id, 1);
    expect(await app.startsOf(id)).toContain(START);
  });
});

describe("no times on a link that took 30 bookings in the last hour (criterion 3)", () => {
  /** Every 15 minutes, all day, for three days. */
  const WIDE: Partial<LinkBody> = { durationMin: 15, startMin: 0, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], aheadDays: 3 };

  it.each(["in the demo", "outside the demo"])("%s, offers none, cancelled bookings counted, until the oldest of the 30 is more than an hour old", async (mode) => {
    if (mode === "in the demo") inTheDemo();
    const { host, id } = await google.hostWithLink(WIDE);
    const times = await app.startsOf(id);
    expect(times.length).toBeGreaterThan(200);
    const starts = times.slice(40, 75);
    // One booking a minute, from +0 to +29 min; ten of them cancelled.
    const tokens: string[] = [];
    for (let i = 0; i < 30; i++) {
      setNow(NOW + i * MIN);
      tokens.push((await google.bookIt(id, starts[i], GUEST)).token);
      if (i < 29) expect(await app.startsOf(id), `after ${i + 1}`).not.toEqual([]);
    }
    for (const token of tokens.slice(0, 10)) expect((await app.cancel(token)).status).toBe(200);
    expect(await app.startsOf(id), "30 in the hour").toEqual([]);
    setNow(NOW + HOUR - 1);
    expect(await app.startsOf(id), "the oldest is 1 ms short of an hour old").toEqual([]);
    // GET and POST agree on the hour's very edge.
    setNow(NOW + HOUR);
    const edge = await app.startsOf(id);
    const tried = await app.book(id, { start: starts[30], ...GUEST });
    if (edge.length === 0) expect([tried.status, tried.json], "GET offers none, so POST is full").toEqual([429, LINK_FULL]);
    else expect(tried.status, "GET offers times, so POST isn't full").toBe(200);
    if (tried.status === 200) {
      // Undo it for the rest of the test.
      db.db().prepare("DELETE FROM bookings WHERE start_ms = ?").run(starts[30]);
    }
    setNow(NOW + HOUR + 1);
    const later = await app.startsOf(id);
    expect(later).toEqual(expect.arrayContaining(starts.slice(0, 10)));
    // One more fills the hour again (+1 to +29 min, and this one).
    await google.bookIt(id, starts[31], GUEST);
    expect(await app.startsOf(id)).toEqual([]);
    setNow(NOW + HOUR + MIN + 1);
    expect(await app.startsOf(id)).not.toEqual([]);
    expect(db.getUser(host.id)!.booking_access).toBe(1);
  });
});
