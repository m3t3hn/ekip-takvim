import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyBookingLinks } from "@/lib/types";
import { at } from "./booking-reference";
import { CANT_BOOK, TAKEN, bookingApp, type Answer } from "./booking-helpers";
import { CANT_CANCEL, googleSide, inTheDemo, withGoogle, type GoogleHost } from "./booking-google-helpers";
import { failures, fakeGoogle, gate, shortTimeouts, waitFor, type Call, type Kind } from "./google-fake";
import { EVENTS_SCOPE, READ_SCOPE, fakeTokens } from "./google-fake-tokens";
import { captureConsole } from "./link-helpers";

// Booking after "sync every minute" (run 2026-11-21-ekip-booking-tokens):
// a booking's Google requests (free/busy, the insert, and the cancel's delete)
// under the token rules the sync has since the merge of feature/ics-links.
// - Criterion 2: they use the access token kept for the host, until 5 minutes
//   before the expires_in Google gave.
// - Criterion 3: one Google answers 401 is made once more with a new token,
//   and nobody is marked.
// - Criterion 4: only a refresh token Google refuses (invalid_grant) marks the
//   host; at the token step with one token request.
// - Criterion 5: a 401 to the new token too fails the request as today, marks
//   nobody, and that token isn't used again.
// - Criterion 6: after Allow access, the next insert carries the sign-in's
//   token or a newer one.
// - Criterion 7: the visitor's answers, the demo, and no access token in a
//   row, a log line or an answer.
// POST /api/book/[id], POST /api/book/cancel/[token] and POST
// /api/me/bookings/[id]/cancel outside the demo (Google sign-in set up,
// DEMO_MODE unset), with Google behind a stubbed fetch that hands out a new
// access token at every token request (google-fake-tokens.ts).
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "t".repeat(40);
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.APP_URL = "https://cal.example.com";
delete process.env.EXPOSURE;
withGoogle();

const app = await bookingApp(jar);
const { db, sync, NextRequest } = app;
const googleRoute = await import("@/app/auth/google/route");
const callbackRoute = await import("@/app/auth/google/callback/route");
const fake = fakeGoogle();
const google = googleSide(app, fake);
const tokens = fakeTokens(fake);

const ist = (d: number, h: number, m = 0) => at("Europe/Istanbul", 2026, 11, d, h, m);
/** 2026-11-18, a Wednesday, 09:00 in Istanbul. */
const NOW = ist(18, 9);
const MIN = 60_000;
/** Times the host's link offers. */
const SLOTS = [ist(19, 10), ist(19, 10, 30), ist(19, 11), ist(19, 11, 30)];
const TITLE = "Token call";
/** The visitor. Their name, email and note never reach a log line. */
const VISITOR = { name: "Tomris Kalkan", email: "tomris.kalkan@guests.example.org", note: "Token note 6610: about the renewal" };
const NEVER_LOGGED = ["Tomris", "Kalkan", "tomris.kalkan", "Token note 6610"];
/** What Google's refused refresh token leaves on the host (token_error). */
const REFUSED = "Google access expired or was revoked";

const setNow = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};
const dropKeptTokens = () => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.google-tokens")];
};

let lines: string[] = [];
/** Answers outside /api/book/ (the host's, the sign-in's), for the privacy check. */
const answers: string[] = [];
let timeouts: ReturnType<typeof shortTimeouts> | null = null;

beforeAll(() => {
  lines = captureConsole();
});
beforeEach(() => {
  db.resetAll();
  app.signOut();
  setNow(NOW);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.booking-limits")];
  dropKeptTokens();
  answers.length = 0;
  fake.reset();
  fake.install();
  tokens.reset();
  tokens.install();
  withGoogle();
});
afterEach(async () => {
  // A 409 or a sign-in starts a sync in the background: let it finish on the fake first.
  await fake.idle();
  timeouts?.mockRestore();
  timeouts = null;
  // Criterion 7: no access token in any row, log line or answer, whatever the test did.
  const handedOut = [...tokens.handed.map((h) => h.token), ...fake.accounts.map((a) => a.accessToken)];
  const texts: [string, string[]][] = [
    ["row", [app.everything()]],
    ["log line", lines],
    ["answer", [...app.visitorAnswers.map((a) => a.text), ...answers]],
  ];
  for (const [what, all] of texts) {
    for (const text of all) {
      expect(text, `an access token in a ${what}`).not.toContain("ya29.");
      for (const token of handedOut) expect(text, `an access token in a ${what}`).not.toContain(token);
    }
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
  process.env.CONFIG_YAML = CONFIG;
  withGoogle();
  expect(fake.problems).toEqual([]);
  const log = lines.join("\n");
  for (const bit of NEVER_LOGGED) expect(log, `the log holds "${bit}"`).not.toContain(bit);
});

// ---------------------------------------------------------------------------

/** A Google host with one link (with Meet) that offers SLOTS, unless they haven't allowed booked meetings. */
async function hostWithLink(opts: { bookingAccess?: boolean } = {}) {
  const { host, id } = await google.hostWithLink({ title: TITLE, meet: true }, { name: "Deniz Host", ...opts });
  if (opts.bookingAccess !== false) expect(await app.startsOf(id)).toEqual(expect.arrayContaining(SLOTS));
  return { host, id };
}

/** A sync round, as the scheduler runs it, at `t`. */
async function roundAt(t: number) {
  setNow(t);
  await sync.syncNow();
}

const of = (calls: Call[], kind: Kind) => calls.filter((c) => c.kind === kind);
/** The Calendar API requests among `calls`: everything but the token endpoint. */
const apiCalls = (calls: Call[]) => calls.filter((c) => c.kind !== "token" && c.kind !== "revoke");
const calendarOf = (c: Call) => ((c.json?.items ?? []) as { id: string }[])[0]?.id;
const userOf = (h: GoogleHost) => db.getUser(h.id)!;

/** Book `start` as the visitor: the answer, and the calls made meanwhile. */
async function book(id: string, start: number) {
  const from = fake.calls.length;
  const a = await app.book(id, { start, ...VISITOR });
  return { a, calls: fake.calls.slice(from) };
}

/** A booking made as with no 401: the answer a booking gets, its row with its event, and that one event in Google. */
function expectMade(a: Answer, h: GoogleHost, start: number) {
  expect(a.status, a.text).toBe(200);
  const made = a.json as Record<string, unknown>;
  expect(Object.keys(made).sort()).toEqual(["cancelUrl", "end", "hostName", "invited", "start", "title"]);
  expect(made).toMatchObject({ start, end: start + 30 * MIN, title: TITLE, hostName: h.name, invited: true });
  expect(String(made.cancelUrl)).toMatch(/^https:\/\/cal\.example\.com\/book\/cancel\/[A-Za-z0-9_-]+$/);
  const row = app.bookingRows().find((r) => r.start_ms === start && r.cancelled_at === null)!;
  expect(row, "the stored booking").toBeTruthy();
  expect(row.event_id, "its event, under the booking's own id").toBe(String(row.id).replace(/-/g, ""));
  expect(row.calendar_id).toBe(h.calendarId);
  expect((fake.events.get(h.calendarId) ?? []).filter((e) => e.id === row.event_id)).toHaveLength(1);
  return { row, bookingId: String(row.id), eventId: String(row.event_id), token: new URL(String(made.cancelUrl)).pathname.split("/").pop()! };
}

/** A booking that failed as today: 503, nothing of it kept, no event left in Google. */
function expectFailed(a: Answer, h: GoogleHost) {
  expect([a.status, a.json]).toEqual([503, CANT_BOOK]);
  expect(app.bookingRows()).toEqual([]);
  const stored = app.everything();
  for (const bit of [VISITOR.name, VISITOR.email, VISITOR.note]) expect(stored).not.toContain(bit);
  expect(fake.events.get(h.calendarId) ?? []).toEqual([]);
}

/** A session cookie the host has now. */
const sessionOf = (h: GoogleHost) => app.secrets.sessionValue(userOf(h)).value;
/** What the host's own page answers with `cookie`: 200 while that session lasts. */
async function statusWith(cookie: string): Promise<number> {
  const saved = jar.session;
  jar.session = cookie;
  try {
    const a = await app.myLinks();
    answers.push(a.text);
    return a.status;
  } finally {
    jar.session = saved;
  }
}

/** Nobody marked: no token_error, the same sessions, booking access as it was. */
async function expectNobodyMarked(h: GoogleHost, before: { cookie: string; version: number }) {
  expect(userOf(h)).toMatchObject({ token_error: null, session_version: before.version, booking_access: 1 });
  expect(await statusWith(before.cookie), "the host's session").toBe(200);
}

/** Marked as having to sign in again: token_error set, their sessions ended. */
async function expectMarked(h: GoogleHost, before: { cookie: string; version: number }) {
  const user = userOf(h);
  expect(user.token_error).toBe(REFUSED);
  expect(user.session_version).toBeGreaterThan(before.version);
  expect(await statusWith(before.cookie), "the host's session").toBe(401);
}

const sessionsOf = (h: GoogleHost) => ({ cookie: sessionOf(h), version: userOf(h).session_version });

type Booked = { host: GoogleHost; id: string; token: string; bookingId: string; eventId: string; start: number };

/** The two ways to cancel, each giving the answer. */
const ROUTES = {
  "the cancel link": (b: Booked) => app.cancel(b.token),
  "the host": async (b: Booked) => {
    app.signIn(b.host.id);
    try {
      const a = await app.cancelMine(b.bookingId);
      answers.push(a.text);
      return a;
    } finally {
      app.signOut();
    }
  },
};
type Route = keyof typeof ROUTES;
const ROUTE_NAMES = Object.keys(ROUTES) as Route[];

/** Cancel by `route`: the answer, and the calls made meanwhile. */
async function cancelBy(route: Route, b: Booked) {
  const from = fake.calls.length;
  const a = await ROUTES[route](b);
  return { a, calls: fake.calls.slice(from) };
}

/** What a cancelled booking answers, by route, as with no 401. */
function expectCancelled(route: Route, b: Booked, a: Answer) {
  expect(a.status, a.text).toBe(200);
  if (route === "the cancel link") {
    expect(a.json).toEqual({ title: TITLE, start: b.start, end: b.start + 30 * MIN, hostName: b.host.name, cancelled: true, ended: false, bookAgain: `/book/${b.id}` });
  } else {
    const mine = a.json as MyBookingLinks;
    expect(mine.upcoming.map((u) => u.id)).not.toContain(b.bookingId);
    expect(mine.links.map((l) => l.id)).toEqual([b.id]);
    expect(mine.bookingAccess).toBe(true);
  }
}

/** A booking made outside the demo at SLOTS[0], with its event. */
async function booked(h: GoogleHost, id: string): Promise<Booked> {
  const { a } = await book(id, SLOTS[0]);
  const made = expectMade(a, h, SLOTS[0]);
  return { host: h, id, token: made.token, bookingId: made.bookingId, eventId: made.eventId, start: SLOTS[0] };
}

const rowOf = (bookingId: string) => app.bookingRows().find((r) => r.id === bookingId)!;

/** Each DELETE among `calls`: its calendar and event, decoded, and its query. */
const deletesIn = (calls: Call[]) =>
  of(calls, "delete").map((c) => {
    const parts = c.url.pathname.split("/");
    return { calendarId: decodeURIComponent(parts[4]), eventId: decodeURIComponent(parts[6]), sendUpdates: c.url.searchParams.get("sendUpdates") };
  });

/** Still booked: the row, its event in Google, the host's upcoming bookings, its time not offered. */
async function expectStands(b: Booked) {
  expect(rowOf(b.bookingId).cancelled_at).toBeNull();
  expect((fake.events.get(b.host.calendarId) ?? []).map((e) => e.id)).toContain(b.eventId);
  app.signIn(b.host.id);
  const mine = await app.myLinks();
  app.signOut();
  answers.push(mine.text);
  expect((mine.json as MyBookingLinks).upcoming.map((u) => u.id)).toEqual([b.bookingId]);
}

/**
 * The host presses Allow access on My settings: GET /auth/google?booking=1,
 * then Google's callback, where they grant calendar.events. Google answers
 * the code with a new access token, `refreshToken` or none, and `expiresIn`.
 * Returns that sign-in's access token and where its token call is in fake.calls.
 */
async function allowAccess(h: GoogleHost, refreshToken: string | null, expiresIn: number | null = 3600) {
  const start = googleRoute.GET(new NextRequest("https://cal.example.com/auth/google?booking=1"));
  const consent = new URL(start.headers.get("location")!);
  expect(consent.searchParams.get("scope")?.split(" ")).toContain(EVENTS_SCOPE);
  const state = consent.searchParams.get("state")!;
  expect(start.cookies.get("ekip_oauth_state")?.value).toBe(state);
  const code = tokens.signIn({
    account: h.account,
    sub: h.google_sub!,
    email: h.email,
    name: h.name,
    scopes: [READ_SCOPE, EVENTS_SCOPE],
    refreshToken,
    expiresIn,
  });
  const from = fake.calls.length;
  const res = await callbackRoute.GET(
    new NextRequest(`https://cal.example.com/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `ekip_oauth_state=${state}` },
    }),
  );
  answers.push(JSON.stringify([...res.headers.entries()]));
  // Back to My settings, signed in.
  expect(new URL(res.headers.get("location")!).pathname).toBe("/settings");
  expect(res.cookies.get("ekip_session")?.value).toBeTruthy();
  const exchange = fake.calls.slice(from).find((c) => c.kind === "token" && c.form?.get("grant_type") === "authorization_code")!;
  expect(exchange, "the sign-in's code was exchanged").toBeTruthy();
  return { token: tokens.handedBy(exchange)!, at: fake.calls.indexOf(exchange) };
}

// ---------------------------------------------------------------------------

describe("booking's Google requests use the kept access token (criterion 2)", () => {
  it("a booking one minute after a sync round asks for no token: its free/busy check and insert carry the round's token", async () => {
    const { host: h, id } = await hostWithLink();
    await roundAt(NOW);
    expect(tokens.refreshes(h.account)).toHaveLength(1);
    const [kept] = tokens.tokensOf(h.account);
    expect(apiCalls(fake.calls).map(tokens.carried), "the round read Google with it").toEqual([kept, kept]);

    setNow(NOW + MIN);
    const { a, calls } = await book(id, SLOTS[0]);
    expectMade(a, h, SLOTS[0]);
    expect(of(calls, "token")).toEqual([]);
    expect(calls.map((c) => [c.kind, tokens.carried(c)])).toEqual([
      ["freeBusy", kept],
      ["insert", kept],
    ]);
  });

  it.each(ROUTE_NAMES)("so does cancelling by %s: after a booking and a round, the delete asks for no token and carries the kept one", async (route) => {
    const { host: h, id } = await hostWithLink();
    const b = await booked(h, id);
    const [kept] = tokens.tokensOf(h.account);
    await roundAt(NOW + MIN);
    setNow(NOW + 2 * MIN);
    const { a, calls } = await cancelBy(route, b);
    expectCancelled(route, b, a);
    expect(calls.map((c) => [c.kind, tokens.carried(c)])).toEqual([["delete", kept]]);
    // No token request since the booking's own.
    expect(tokens.refreshes(h.account)).toHaveLength(1);
  });

  it.each([3600, 1200])("with expires_in %i: bookings use the round's token until 5 minutes before it ends, and from then on a new one", async (seconds) => {
    tokens.options.expiresIn = seconds;
    const { host: h, id } = await hostWithLink();
    await roundAt(NOW);
    const [kept] = tokens.tokensOf(h.account);
    const edge = NOW + seconds * 1000 - 5 * MIN;

    setNow(edge - 1);
    const before = await book(id, SLOTS[0]);
    expectMade(before.a, h, SLOTS[0]);
    expect(of(before.calls, "token")).toEqual([]);
    expect(apiCalls(before.calls).map(tokens.carried)).toEqual([kept, kept]);

    setNow(edge);
    const after = await book(id, SLOTS[1]);
    expectMade(after.a, h, SLOTS[1]);
    const asked = tokens.refreshes(h.account, after.calls);
    expect(asked).toHaveLength(1);
    const renewed = tokens.handedBy(asked[0]);
    expect(renewed).not.toBe(kept);
    expect(after.calls[0], "asked for first").toBe(asked[0]);
    expect(apiCalls(after.calls).map(tokens.carried)).toEqual([renewed, renewed]);
  });
});

describe("a 401 on a booking's Google request (criterion 3)", () => {
  it("free/busy answered 401: one new token, the check made once more with it, the booking made as with no 401, nobody marked, and later requests use it", async () => {
    const { host: h, id } = await hostWithLink();
    await roundAt(NOW);
    const [stale] = tokens.tokensOf(h.account);
    // Google turned the kept token down.
    tokens.turnDown(stale);
    setNow(NOW + MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await book(id, SLOTS[0]);
    expectMade(a, h, SLOTS[0]);
    const asked = tokens.refreshes(h.account, calls);
    expect(asked).toHaveLength(1);
    const renewed = tokens.handedBy(asked[0])!;
    expect(calls.map((c) => [c.kind, c.kind === "token" ? tokens.handedBy(c) : tokens.carried(c)])).toEqual([
      ["freeBusy", stale],
      ["token", renewed],
      ["freeBusy", renewed],
      ["insert", renewed],
    ]);
    expect(calendarOf(of(calls, "freeBusy")[1])).toBe(h.calendarId);
    await expectNobodyMarked(h, sessions);
    // The visitor's page no longer offers the time, as after any booking.
    expect(await app.startsOf(id)).not.toContain(SLOTS[0]);

    // Later requests use it: the next booking and the next round ask for no token.
    setNow(NOW + 2 * MIN);
    const next = await book(id, SLOTS[1]);
    expectMade(next.a, h, SLOTS[1]);
    expect(next.calls.map((c) => [c.kind, tokens.carried(c)])).toEqual([
      ["freeBusy", renewed],
      ["insert", renewed],
    ]);
    const from = fake.calls.length;
    await roundAt(NOW + 3 * MIN);
    expect(of(fake.calls.slice(from), "token")).toEqual([]);
    expect(new Set(apiCalls(fake.calls.slice(from)).map(tokens.carried))).toEqual(new Set([renewed]));
    await expectNobodyMarked(h, sessions);
  });

  it("the insert answered 401: one new token, the insert made once more with it under the same event id, one event, nobody marked", async () => {
    const { host: h, id } = await hostWithLink();
    await roundAt(NOW);
    const [stale] = tokens.tokensOf(h.account);
    // The kept token went stale between the check and the insert.
    tokens.turnDown(stale, ["insert"]);
    setNow(NOW + MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await book(id, SLOTS[0]);
    const made = expectMade(a, h, SLOTS[0]);
    const asked = tokens.refreshes(h.account, calls);
    expect(asked).toHaveLength(1);
    const renewed = tokens.handedBy(asked[0])!;
    expect(calls.map((c) => [c.kind, c.kind === "token" ? tokens.handedBy(c) : tokens.carried(c)])).toEqual([
      ["freeBusy", stale],
      ["insert", stale],
      ["token", renewed],
      ["insert", renewed],
    ]);
    // Made once more as it was: the same event id, the same Meet request, the same everything.
    const [first, again] = of(calls, "insert");
    expect(first.json!.id).toBe(made.eventId);
    expect(again.json).toEqual(first.json);
    expect(again.url.search).toBe(first.url.search);
    // One event, and nothing to delete: an insert answered 401 made none.
    expect(fake.made).toEqual([made.eventId]);
    expect(of(calls, "delete")).toEqual([]);
    await expectNobodyMarked(h, sessions);

    // Later requests use it.
    setNow(NOW + 2 * MIN);
    const next = await book(id, SLOTS[1]);
    expectMade(next.a, h, SLOTS[1]);
    expect(next.calls.map((c) => [c.kind, tokens.carried(c)])).toEqual([
      ["freeBusy", renewed],
      ["insert", renewed],
    ]);
  });

  it.each(ROUTE_NAMES)("the cancel's delete answered 401, by %s: one new token, the delete made once more with it, cancelled as with no 401, nobody marked", async (route) => {
    const { host: h, id } = await hostWithLink();
    const b = await booked(h, id);
    // The booking kept its token, and Google has turned it down since.
    const [stale] = tokens.tokensOf(h.account);
    tokens.turnDown(stale);
    setNow(NOW + 5 * MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await cancelBy(route, b);
    expectCancelled(route, b, a);
    const asked = tokens.refreshes(h.account, calls);
    expect(asked).toHaveLength(1);
    const renewed = tokens.handedBy(asked[0])!;
    expect(calls.map((c) => [c.kind, c.kind === "token" ? tokens.handedBy(c) : tokens.carried(c)])).toEqual([
      ["delete", stale],
      ["token", renewed],
      ["delete", renewed],
    ]);
    const the = { calendarId: h.calendarId, eventId: b.eventId, sendUpdates: "all" };
    expect(deletesIn(calls)).toEqual([the, the]);
    // Cancelled: the event is gone from Google, the time offered again.
    expect((fake.events.get(h.calendarId) ?? []).map((e) => e.id)).not.toContain(b.eventId);
    expect(rowOf(b.bookingId).cancelled_at).toBe(NOW + 5 * MIN);
    expect(await app.startsOf(id)).toContain(SLOTS[0]);
    await expectNobodyMarked(h, sessions);

    // Later requests use it.
    setNow(NOW + 6 * MIN);
    const next = await book(id, SLOTS[1]);
    expectMade(next.a, h, SLOTS[1]);
    expect(next.calls.map((c) => [c.kind, tokens.carried(c)])).toEqual([
      ["freeBusy", renewed],
      ["insert", renewed],
    ]);
  });

  it("free/busy over several calendars: one new token, every calendar answered 401 asked again with it, and a busy time on any of them still takes the time", async () => {
    const { host: h, id } = await hostWithLink();
    const team = "team-tokens@group.calendar.google.com";
    const boss = "boss.tokens@example.com";
    google.addCalendars(h, [
      { id: team, summary: "Team", access: "events", included: true },
      { id: boss, summary: "Boss", access: "freebusy", included: true },
    ]);
    await roundAt(NOW);
    const all = [h.calendarId, team, boss].sort();

    // Free on all three: made.
    const [first] = tokens.tokensOf(h.account);
    tokens.turnDown(first);
    setNow(NOW + MIN);
    const sessions = sessionsOf(h);
    const free = await book(id, SLOTS[0]);
    expectMade(free.a, h, SLOTS[0]);
    let asked = tokens.refreshes(h.account, free.calls);
    expect(asked).toHaveLength(1);
    let renewed = tokens.handedBy(asked[0])!;
    let checks = of(free.calls, "freeBusy");
    const turned = checks.filter((c) => tokens.carried(c) === first).map(calendarOf);
    expect(turned.length).toBeGreaterThan(0);
    const again = checks.filter((c) => free.calls.indexOf(c) > free.calls.indexOf(asked[0]));
    expect(again.every((c) => tokens.carried(c) === renewed)).toBe(true);
    expect(again.map(calendarOf)).toEqual(expect.arrayContaining(turned));
    // Each of the three was checked and answered with one token or the other, and no check came after the insert.
    expect([...new Set(checks.map(calendarOf))].sort()).toEqual(all);
    expect(of(free.calls, "insert").map(tokens.carried)).toEqual([renewed]);

    // Busy on the free/busy-only calendar, which the app hasn't read since: still 409 after the new token.
    tokens.turnDown(renewed);
    fake.busy.set(boss, [{ start: SLOTS[1] + 10 * MIN, end: SLOTS[1] + 20 * MIN }]);
    setNow(NOW + 2 * MIN);
    const busy = await book(id, SLOTS[1]);
    expect([busy.a.status, busy.a.json]).toEqual([409, TAKEN]);
    asked = tokens.refreshes(h.account, busy.calls);
    expect(asked).toHaveLength(1);
    const stale = renewed;
    renewed = tokens.handedBy(asked[0])!;
    checks = of(busy.calls, "freeBusy");
    const afterRenewal = checks.filter((c) => busy.calls.indexOf(c) > busy.calls.indexOf(asked[0]));
    expect(checks.filter((c) => !afterRenewal.includes(c)).every((c) => tokens.carried(c) === stale)).toBe(true);
    expect(afterRenewal.every((c) => tokens.carried(c) === renewed)).toBe(true);
    expect(afterRenewal.map(calendarOf)).toContain(boss);
    expect(of(busy.calls, "insert")).toEqual([]);
    expect(app.bookingRows().filter((r) => r.start_ms === SLOTS[1])).toEqual([]);
    await expectNobodyMarked(h, sessions);
  });

  it("free/busy with one calendar answering 500 and another 401: 503 as today, at most one new token, nobody marked", async () => {
    const { host: h, id } = await hostWithLink();
    const boss = "boss.failing@example.com";
    google.addCalendars(h, [{ id: boss, summary: "Boss", access: "freebusy", included: true }]);
    await roundAt(NOW);
    const [stale] = tokens.tokensOf(h.account);
    tokens.answer.freeBusy = (call, t) => (calendarOf(call) === boss ? failures.serverError() : t.token === stale ? failures.unauthorized() : undefined);
    setNow(NOW + MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await book(id, SLOTS[0]);
    expectFailed(a, h);
    expect(tokens.refreshes(h.account, calls).length).toBeLessThanOrEqual(1);
    expect(of(calls, "insert")).toEqual([]);
    await expectNobodyMarked(h, sessions);
    // As today: the time is offered again, and books once Google answers.
    expect(await app.startsOf(id)).toContain(SLOTS[0]);
    delete tokens.answer.freeBusy;
    setNow(NOW + 2 * MIN);
    expectMade((await book(id, SLOTS[0])).a, h, SLOTS[0]);
  });

  it("an insert made once more that times out: one DELETE of the event id it sent, carrying the new token, and 503 as today", async () => {
    timeouts = shortTimeouts(30);
    const { host: h, id } = await hostWithLink();
    await roundAt(NOW);
    const [stale] = tokens.tokensOf(h.account);
    tokens.turnDown(stale, ["insert"]);
    // Google never answers the insert with the new token.
    tokens.answer.insert = (_call, t) => (t.token !== stale ? "timeout" : undefined);
    setNow(NOW + MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await book(id, SLOTS[0]);
    expectFailed(a, h);
    const asked = tokens.refreshes(h.account, calls);
    expect(asked).toHaveLength(1);
    const renewed = tokens.handedBy(asked[0])!;
    const inserts = of(calls, "insert");
    expect(inserts.map(tokens.carried)).toEqual([stale, renewed]);
    const deletes = of(calls, "delete");
    expect(deletes).toHaveLength(1);
    expect(tokens.carried(deletes[0])).toBe(renewed);
    expect(deletes[0].url.pathname).toBe(`/calendar/v3/calendars/primary/events/${String(inserts[1].json!.id)}`);
    expect(calls.indexOf(deletes[0])).toBeGreaterThan(calls.indexOf(inserts[1]));
    await expectNobodyMarked(h, sessions);
  });
});

describe("a refresh token Google refuses (criterion 4)", () => {
  it("at a booking's token step: one token request, the host marked (token_error set, sessions ended), and the booking fails as today", async () => {
    const { host: h, id } = await hostWithLink();
    tokens.next(h.account, "invalid_grant");
    const sessions = sessionsOf(h);

    const { a, calls } = await book(id, SLOTS[0]);
    expectFailed(a, h);
    expect(calls.map((c) => c.kind)).toEqual(["token"]);
    await expectMarked(h, sessions);
    // As today: their times aren't offered while they have to sign in again.
    expect(await app.startsOf(id)).toEqual([]);
  });

  it.each(ROUTE_NAMES)("at a cancel's token step, by %s: one token request, the host marked, 'Couldn't cancel right now', and the booking stands", async (route) => {
    const { host: h, id } = await hostWithLink();
    const b = await booked(h, id);
    // Nothing kept: the cancel asks Google for a token.
    dropKeptTokens();
    tokens.next(h.account, "invalid_grant");
    setNow(NOW + 5 * MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await cancelBy(route, b);
    expect([a.status, a.json]).toEqual([503, CANT_CANCEL]);
    expect(calls.map((c) => c.kind)).toEqual(["token"]);
    await expectMarked(h, sessions);
    await expectStands(b);
  });

  it.each(["freeBusy", "insert"] as const)("on the renewal after a 401 on %s: one token request, the host marked, and the booking fails as today", async (kind) => {
    const { host: h, id } = await hostWithLink();
    await roundAt(NOW);
    const [stale] = tokens.tokensOf(h.account);
    tokens.turnDown(stale, [kind]);
    tokens.next(h.account, "invalid_grant");
    setNow(NOW + MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await book(id, SLOTS[0]);
    expectFailed(a, h);
    expect(tokens.refreshes(h.account, calls)).toHaveLength(1);
    // Not made once more: there's no new token.
    expect(of(calls, kind).map(tokens.carried)).toEqual([stale]);
    if (kind === "freeBusy") expect(of(calls, "insert")).toEqual([]);
    expect(of(calls, "delete")).toEqual([]);
    await expectMarked(h, sessions);
    expect(await app.startsOf(id)).toEqual([]);
  });

  it.each(ROUTE_NAMES)("on the renewal after a 401 on the cancel's delete, by %s: the host marked, 'Couldn't cancel right now', and the booking stands", async (route) => {
    const { host: h, id } = await hostWithLink();
    const b = await booked(h, id);
    const [stale] = tokens.tokensOf(h.account);
    tokens.turnDown(stale);
    tokens.next(h.account, "invalid_grant");
    setNow(NOW + 5 * MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await cancelBy(route, b);
    expect([a.status, a.json]).toEqual([503, CANT_CANCEL]);
    expect(calls.map((c) => [c.kind, tokens.carried(c)])).toEqual([
      ["delete", stale],
      ["token", null],
    ]);
    await expectMarked(h, sessions);
    await expectStands(b);
  });
});

describe("a 401 to the new token too (criterion 5)", () => {
  it("free/busy: no third token request, the booking fails as today, nobody marked, and the next booking asks for a new token before any request", async () => {
    const { host: h, id } = await hostWithLink();
    // The token step's token and the renewal's: Google turns both down.
    tokens.next(h.account, { turnedDown: "all" }, { turnedDown: "all" });
    const sessions = sessionsOf(h);

    const { a, calls } = await book(id, SLOTS[0]);
    expectFailed(a, h);
    const asked = tokens.refreshes(h.account, calls);
    expect(asked, "the token step's and one renewal").toHaveLength(2);
    const [first, renewed] = asked.map(tokens.handedBy);
    expect(calls.map((c) => [c.kind, c.kind === "token" ? tokens.handedBy(c) : tokens.carried(c)])).toEqual([
      ["token", first],
      ["freeBusy", first],
      ["token", renewed],
      ["freeBusy", renewed],
    ]);
    await expectNobodyMarked(h, sessions);
    // As today: the time is offered again.
    expect(await app.startsOf(id)).toContain(SLOTS[0]);

    // Neither token is used again: the next booking asks for a new one first.
    setNow(NOW + MIN);
    const next = await book(id, SLOTS[0]);
    expectMade(next.a, h, SLOTS[0]);
    expect(next.calls[0].kind).toBe("token");
    const fresh = tokens.handedBy(next.calls[0]);
    expect(next.calls.slice(1).map((c) => [c.kind, tokens.carried(c)])).toEqual([
      ["freeBusy", fresh],
      ["insert", fresh],
    ]);
  });

  it("the insert: made twice under the same event id with one new token, no DELETE, 503 as today, nobody marked, and the next booking asks for a new token first", async () => {
    const { host: h, id } = await hostWithLink();
    await roundAt(NOW);
    const [stale] = tokens.tokensOf(h.account);
    tokens.turnDown(stale, ["insert"]);
    tokens.next(h.account, { turnedDown: ["insert"] });
    setNow(NOW + MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await book(id, SLOTS[0]);
    expectFailed(a, h);
    const asked = tokens.refreshes(h.account, calls);
    expect(asked).toHaveLength(1);
    const renewed = tokens.handedBy(asked[0]);
    const inserts = of(calls, "insert");
    expect(inserts.map(tokens.carried)).toEqual([stale, renewed]);
    expect(inserts[1].json).toEqual(inserts[0].json);
    // A 4xx made nothing: nothing to delete.
    expect(of(calls, "delete")).toEqual([]);
    expect(fake.made).toEqual([]);
    await expectNobodyMarked(h, sessions);
    expect(await app.startsOf(id)).toContain(SLOTS[0]);

    setNow(NOW + 2 * MIN);
    const next = await book(id, SLOTS[0]);
    expectMade(next.a, h, SLOTS[0]);
    expect(next.calls[0].kind).toBe("token");
    const fresh = tokens.handedBy(next.calls[0]);
    expect(next.calls.slice(1).map((c) => [c.kind, tokens.carried(c)])).toEqual([
      ["freeBusy", fresh],
      ["insert", fresh],
    ]);
  });

  it("once per booking: after free/busy was made once more, a 401 on the insert asks for no other token, and the booking fails with nobody marked", async () => {
    const { host: h, id } = await hostWithLink();
    // The token step's token is turned down for everything, the renewal's for the insert.
    tokens.next(h.account, { turnedDown: "all" }, { turnedDown: ["insert"] });
    const sessions = sessionsOf(h);

    const { a, calls } = await book(id, SLOTS[0]);
    expectFailed(a, h);
    const asked = tokens.refreshes(h.account, calls);
    expect(asked, "the token step's and one renewal").toHaveLength(2);
    const [first, renewed] = asked.map(tokens.handedBy);
    expect(calls.map((c) => [c.kind, c.kind === "token" ? tokens.handedBy(c) : tokens.carried(c)])).toEqual([
      ["token", first],
      ["freeBusy", first],
      ["token", renewed],
      ["freeBusy", renewed],
      ["insert", renewed],
    ]);
    await expectNobodyMarked(h, sessions);

    // The renewed token isn't used again.
    setNow(NOW + MIN);
    const next = await book(id, SLOTS[0]);
    expectMade(next.a, h, SLOTS[0]);
    expect(next.calls[0].kind).toBe("token");
    expect(apiCalls(fake.calls).filter((c) => fake.calls.indexOf(c) > fake.calls.indexOf(calls.at(-1)!)).map(tokens.carried)).not.toContain(renewed);
  });

  it.each(ROUTE_NAMES)("the cancel's delete, by %s: no third token request, 'Couldn't cancel right now', the booking stands, nobody marked, and the next cancel asks for a new token first", async (route) => {
    const { host: h, id } = await hostWithLink();
    const b = await booked(h, id);
    const [stale] = tokens.tokensOf(h.account);
    tokens.turnDown(stale);
    tokens.next(h.account, { turnedDown: "all" });
    setNow(NOW + 5 * MIN);
    const sessions = sessionsOf(h);

    const { a, calls } = await cancelBy(route, b);
    expect([a.status, a.json]).toEqual([503, CANT_CANCEL]);
    const asked = tokens.refreshes(h.account, calls);
    expect(asked).toHaveLength(1);
    const renewed = tokens.handedBy(asked[0]);
    expect(calls.map((c) => [c.kind, c.kind === "token" ? tokens.handedBy(c) : tokens.carried(c)])).toEqual([
      ["delete", stale],
      ["token", renewed],
      ["delete", renewed],
    ]);
    await expectStands(b);
    expect(await app.startsOf(id)).not.toContain(SLOTS[0]);
    await expectNobodyMarked(h, sessions);

    // The next cancel asks for a new token first, and goes through.
    setNow(NOW + 6 * MIN);
    const again = await cancelBy(route, b);
    expectCancelled(route, b, again.a);
    expect(again.calls[0].kind).toBe("token");
    const fresh = tokens.handedBy(again.calls[0]);
    expect(again.calls.slice(1).map((c) => [c.kind, tokens.carried(c)])).toEqual([["delete", fresh]]);
  });

  // Decision 2: the token turned down the second time is dropped "with it": only while it's the one kept.
  it("a sign-in's token kept between the renewal and the second 401 stays kept: the next booking uses it and asks for no token", async () => {
    const { host: h, id } = await hostWithLink();
    await roundAt(NOW);
    const [stale] = tokens.tokensOf(h.account);
    tokens.turnDown(stale);
    // The renewal's free/busy check waits, and its token is then turned down too.
    const holding = gate();
    const renewal = () => tokens.handed.find((x) => x.how === "refresh" && x.token !== stale)?.token;
    tokens.answer.freeBusy = async (_call, t) => {
      if (t.token !== renewal()) return undefined;
      await holding.opened;
      return failures.unauthorized();
    };
    setNow(NOW + MIN);
    const booking = book(id, SLOTS[0]);
    let signIn: { token: string } | null = null;
    try {
      await waitFor(() => of(fake.calls, "freeBusy").length === 2, "the check made once more");
      // Meanwhile the host signs in again (Google sends no new refresh token).
      signIn = await allowAccess(h, null);
    } finally {
      holding.open();
    }
    const { a } = await booking;
    expectFailed(a, h);
    await fake.idle();
    delete tokens.answer.freeBusy;

    setNow(NOW + 2 * MIN);
    const next = await book(id, SLOTS[1]);
    expectMade(next.a, h, SLOTS[1]);
    expect(next.calls.map((c) => [c.kind, tokens.carried(c)])).toEqual([
      ["freeBusy", signIn!.token],
      ["insert", signIn!.token],
    ]);
  });
});

describe("Allow access (criterion 6)", () => {
  it.each([
    ["with a new refresh token", "1//allow-access-new-refresh", 3600],
    ["without a new refresh token", null, 3600],
    ["without a new refresh token or expires_in", null, null],
  ] as const)("a host whose kept token is from before it: after Allow access %s, the next booking's insert carries the sign-in's token or a newer one, and booking access stays on", async (_what, refreshToken, expiresIn) => {
    const { host: h, id } = await hostWithLink({ bookingAccess: false });
    // Before Allow access, their tokens can read calendars but not make events.
    tokens.grant(h.account, [READ_SCOPE]);
    await roundAt(NOW);
    const [before] = tokens.tokensOf(h.account);
    expect(tokens.handed.find((t) => t.token === before)?.scopes).toEqual([READ_SCOPE]);
    expect(await app.startsOf(id), "no times without booking access").toEqual([]);

    setNow(NOW + MIN);
    const signIn = await allowAccess(h, refreshToken, expiresIn);
    expect(userOf(h).booking_access).toBe(1);
    if (refreshToken) expect(app.secrets.decrypt(userOf(h).refresh_token!)).toBe(refreshToken);
    // The sync the sign-in starts.
    await fake.idle();

    setNow(NOW + 2 * MIN);
    const { a, calls } = await book(id, SLOTS[0]);
    expectMade(a, h, SLOTS[0]);
    const inserts = of(calls, "insert");
    expect(inserts).toHaveLength(1);
    // Never the token from before: it lacks calendar.events.
    expect(tokens.order(tokens.carried(inserts[0])), "the sign-in's token or a newer one").toBeGreaterThanOrEqual(tokens.order(signIn.token));
    expect(tokens.order(signIn.token)).toBeGreaterThan(tokens.order(before));
    expect(userOf(h)).toMatchObject({ booking_access: 1, token_error: null });
    expect(await app.startsOf(id)).toEqual(expect.arrayContaining(SLOTS.slice(1)));
  });
});

describe("nothing else changes (criterion 7)", () => {
  it("the demo makes no Google request: bookings and cancels by each route, one with a Google event, while a token Google turned down is kept", async () => {
    const { host: h, id } = await hostWithLink();
    // Outside the demo, a booking with its Google event; its token is kept, and Google turns it down since.
    const withEvent = await booked(h, id);
    const [stale] = tokens.tokensOf(h.account);
    tokens.turnDown(stale);
    inTheDemo();
    fake.calls.length = 0;
    setNow(NOW + MIN);
    const made: Booked[] = [];
    for (const start of SLOTS.slice(1, 1 + ROUTE_NAMES.length)) {
      const a = await app.book(id, { start, ...VISITOR });
      expect(a.status, a.text).toBe(200);
      expect(a.json).toMatchObject({ start, invited: false });
      const row = app.bookingRows().find((r) => r.start_ms === start)!;
      const token = new URL((a.json as { cancelUrl: string }).cancelUrl).pathname.split("/").pop()!;
      made.push({ host: h, id, token, bookingId: String(row.id), eventId: "", start });
    }
    setNow(NOW + 2 * MIN);
    for (const [i, route] of ROUTE_NAMES.entries()) expectCancelled(route, made[i], (await cancelBy(route, made[i])).a);
    expectCancelled("the cancel link", withEvent, (await cancelBy("the cancel link", withEvent)).a);
    expect(rowOf(withEvent.bookingId).cancelled_at).toBe(NOW + 2 * MIN);
    expect(fake.calls).toEqual([]);
    expect(userOf(h).token_error).toBeNull();
  });
});
