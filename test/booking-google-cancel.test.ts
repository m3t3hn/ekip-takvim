import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyBookingLinks } from "@/lib/types";
import { at } from "./booking-reference";
import { bookingApp } from "./booking-helpers";
import { BEING_MADE, CANT_CANCEL, googleSide, inTheDemo, withGoogle, type GoogleHost } from "./booking-google-helpers";
import { apiError, failures, fakeGoogle, shortTimeouts, type Outcome } from "./google-fake";
import { captureConsole } from "./link-helpers";

// Booking links, part 2 (run 2026-11-19-ekip-booking-2), criterion 6:
// cancelling a booking outside the demo, by its cancel link
// (POST /api/book/cancel/[token]) or by its host (POST
// /api/me/bookings/[id]/cancel), deletes its Google event first. And
// criterion 8: the demo never calls Google. Google is a stubbed fetch.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "c".repeat(40);
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.APP_URL = "https://cal.example.com";
delete process.env.EXPOSURE;
withGoogle();

const app = await bookingApp(jar);
const { db } = app;
const fake = fakeGoogle();
const google = googleSide(app, fake);

const ist = (d: number, h: number, m = 0) => at("Europe/Istanbul", 2026, 11, d, h, m);
const NOW = ist(18, 9);
const MIN = 60_000;
const START = ist(19, 10, 30);
const GUEST = { name: "Cancel Guest", email: "cancel.guest@guests.example.org", note: "Cancel note 9182" };

const setNow = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};

let lines: string[] = [];
let timeouts: ReturnType<typeof shortTimeouts> | null = null;

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
afterEach(() => {
  timeouts?.mockRestore();
  timeouts = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
  process.env.CONFIG_YAML = CONFIG;
  withGoogle();
  expect(fake.problems).toEqual([]);
  const log = lines.join("\n");
  for (const bit of [GUEST.name, GUEST.email, GUEST.note]) expect(log).not.toContain(bit);
});

type Booked = { host: GoogleHost; id: string; token: string; bookingId: string; eventId: string; calendarId: string };

/** A booking made outside the demo, with its Google event; the calls made so far are forgotten. */
async function booked(): Promise<Booked> {
  const { host, id } = await google.hostWithLink({ title: "Design review" }, { name: "Mert Host" });
  const { token, row } = await google.bookIt(id, START, GUEST);
  expect(row.event_id, "an event").toEqual(expect.any(String));
  expect(row.calendar_id).toBe(host.calendarId);
  google.eventOf(host.calendarId, row.event_id);
  fake.calls.length = 0;
  setNow(NOW + 5 * MIN);
  return { host, id, token, bookingId: String(row.id), eventId: String(row.event_id), calendarId: String(row.calendar_id) };
}

const rowOf = (b: { bookingId: string }) => app.bookingRows().find((r) => r.id === b.bookingId)!;

/** The two ways to cancel, each giving the answer. */
const ROUTES = {
  "the cancel link": (b: Booked) => app.cancel(b.token),
  "the host": async (b: Booked) => {
    app.signIn(b.host.id);
    try {
      return await app.cancelMine(b.bookingId);
    } finally {
      app.signOut();
    }
  },
};
type Route = keyof typeof ROUTES;
const ROUTE_NAMES = Object.keys(ROUTES) as Route[];

/** The one DELETE sent: its calendar and event, decoded, and its query. */
function theDelete() {
  const deletes = fake.of("delete");
  expect(deletes).toHaveLength(1);
  const [call] = deletes;
  const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(call.url.pathname);
  expect(m, call.url.pathname).not.toBeNull();
  return { call, calendarId: decodeURIComponent(m![1]), eventId: decodeURIComponent(m![2]) };
}

/** What part 1 answers for a cancelled booking, by route. */
async function expectCancelledAnswer(route: Route, b: Booked, a: { status: number; json: unknown }) {
  expect(a.status).toBe(200);
  if (route === "the cancel link") {
    expect(a.json).toEqual({ title: "Design review", start: START, end: START + 30 * MIN, hostName: "Mert Host", cancelled: true, ended: false, bookAgain: `/book/${b.id}` });
  } else {
    const mine = a.json as MyBookingLinks;
    expect(mine.upcoming).toEqual([]);
    expect(mine.links.map((l) => l.id)).toEqual([b.id]);
    expect(mine.bookingAccess).toBe(true);
  }
}

describe("cancelling a booking with an event, outside the demo (criterion 6)", () => {
  const done: [string, () => Outcome][] = [
    ["204", () => new Response(null, { status: 204 })],
    ["an empty 200", () => new Response("", { status: 200 })],
    ["404", () => apiError(404, "notFound")],
    ["410", () => apiError(410, "deleted")],
  ];
  const cases = ROUTE_NAMES.flatMap((route) => done.map(([what, answer]) => [route, what, answer] as const));

  it.each(cases)("by %s: Google answering %s to DELETE ...?sendUpdates=all cancels it, as in part 1", async (route, _what, answer) => {
    const b = await booked();
    fake.answer.delete = answer;
    const a = await ROUTES[route](b);
    await expectCancelledAnswer(route, b, a);

    const del = theDelete();
    expect([del.calendarId, del.eventId]).toEqual([b.calendarId, b.eventId]);
    expect(del.call.url.searchParams.get("sendUpdates")).toBe("all");
    expect(del.call.account, "with the host's token").toBe(b.host.account);
    expect(rowOf(b).cancelled_at).toBe(NOW + 5 * MIN);
    // Its time is offered again.
    expect(await app.startsOf(b.id)).toContain(START);
    // And a second try changes nothing, without asking Google.
    fake.calls.length = 0;
    const again = await ROUTES[route](b);
    expect(again.status).toBe(200);
    expect(rowOf(b).cancelled_at).toBe(NOW + 5 * MIN);
    expect(fake.calls).toEqual([]);
  });

  it.each(ROUTE_NAMES)("by %s: deletes the event with Google's own answer (204), and Google no longer has it", async (route) => {
    const b = await booked();
    const a = await ROUTES[route](b);
    await expectCancelledAnswer(route, b, a);
    expect(fake.events.get(b.calendarId)!.map((e) => e.id)).not.toContain(b.eventId);
  });

  // The DELETEs sent. Changed in run 2026-11-21-ekip-booking-tokens: a DELETE
  // answered 401 is made once more with a new token, and failures.unauthorized
  // answers that one 401 too; nobody is signed out by a 401 any more.
  const notDone: [string, () => Outcome, number][] = [
    ["500", failures.serverError, 1],
    ["a timeout", () => "timeout", 1],
    ["401", failures.unauthorized, 2],
  ];
  const failing = ROUTE_NAMES.flatMap((route) => notDone.map(([what, answer, deletes]) => [route, what, answer, deletes] as const));

  it.each(failing)("by %s: Google answering %s answers 503 and the booking stays", async (route, what, answer, deletes) => {
    const b = await booked();
    if (what === "a timeout") timeouts = shortTimeouts(30);
    fake.answer.delete = answer;
    const a = await ROUTES[route](b);
    expect([a.status, a.json]).toEqual([503, CANT_CANCEL]);
    if (deletes === 1) expect(theDelete().eventId).toBe(b.eventId);
    else expect(fake.of("delete").map((c) => decodeURIComponent(c.url.pathname.split("/").pop()!))).toEqual([b.eventId, b.eventId]);
    expect(rowOf(b).cancelled_at).toBeNull();
    expect(db.getUser(b.host.id)!.token_error, "token_error").toBeNull();
    // Still the host's booking, still holding its time.
    app.signIn(b.host.id);
    expect(((await app.myLinks()).json as MyBookingLinks).upcoming.map((u) => u.id)).toEqual([b.bookingId]);
    app.signOut();
    expect(await app.startsOf(b.id)).not.toContain(START);
    if (what === "a timeout") expect(fake.of("delete").every((c) => c.signal !== null)).toBe(true);
    // Once Google deletes it, the cancel goes through.
    delete fake.answer.delete;
    timeouts?.mockRestore();
    timeouts = null;
    fake.calls.length = 0;
    await expectCancelledAnswer(route, b, await ROUTES[route](b));
    expect(rowOf(b).cancelled_at).not.toBeNull();
  });

  it.each(ROUTE_NAMES)("by %s: a token Google won't refresh answers 503 and the booking stays", async (route) => {
    const b = await booked();
    // Changed in run 2026-11-21-ekip-booking-tokens: the booking kept its access
    // token (sync every minute), so drop it, and the cancel asks Google for one.
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.google-tokens")];
    fake.answer.token = failures.tokenServerError;
    const server = await ROUTES[route](b);
    expect([server.status, server.json]).toEqual([503, CANT_CANCEL]);
    expect(rowOf(b).cancelled_at).toBeNull();
    fake.answer.token = failures.invalidGrant;
    const revoked = await ROUTES[route](b);
    expect([revoked.status, revoked.json]).toEqual([503, CANT_CANCEL]);
    expect(rowOf(b).cancelled_at).toBeNull();
    expect(fake.of("delete")).toEqual([]);
  });

  // Changed in part 2b (run 2026-11-19-ekip-booking-2b): made just now and
  // without an event, outside the demo the booking is still being made, so the
  // cancel answers 409 first; 2 minutes on, it's cancelled as before.
  it.each(ROUTE_NAMES)("by %s: a booking made in the demo, without an event, is cancelled with no call to Google once it's 2 minutes old", async (route) => {
    inTheDemo();
    const { host, id } = await google.hostWithLink({ title: "Design review" }, { name: "Mert Host" });
    const { token, row } = await google.bookIt(id, START, GUEST);
    expect(row.event_id).toBeNull();
    withGoogle();
    fake.calls.length = 0;
    const b: Booked = { host, id, token, bookingId: String(row.id), eventId: "", calendarId: "" };
    const early = await ROUTES[route](b);
    expect([early.status, early.json]).toEqual([409, BEING_MADE]);
    expect(rowOf(b)).toEqual(row);
    setNow(NOW + 2 * MIN);
    const a = await ROUTES[route](b);
    await expectCancelledAnswer(route, b, a);
    expect(rowOf(b).cancelled_at).toBe(NOW + 2 * MIN);
    expect(fake.calls).toEqual([]);
  });

  it("frees the time at once, even after a sync read the event as busy", async () => {
    const b = await booked();
    await app.sync.syncOne(b.host.id);
    expect(fake.of("events").length, "the sync read the calendar").toBeGreaterThan(0);
    expect(db.busyBetween(START, START + 30 * MIN, b.host.id), "the event as busy").toHaveLength(1);
    expect((await app.cancel(b.token)).status).toBe(200);
    expect(await app.startsOf(b.id)).toContain(START);
  });
});

describe("the demo (criterion 8)", () => {
  it("books and cancels by both routes with no request to Google, and answers invited: false", async () => {
    inTheDemo();
    const { host, id } = await google.hostWithLink({ title: "Design review", meet: true }, { name: "Mert Host" });
    fake.calls.length = 0;
    const first = await google.bookIt(id, START, GUEST);
    expect(Object.keys(first.made).sort()).toEqual(["cancelUrl", "end", "hostName", "invited", "start", "title"]);
    expect(first.made.invited).toBe(false);
    const second = await google.bookIt(id, ist(19, 11), GUEST);
    expect(second.made.invited).toBe(false);
    expect([first.row.event_id, second.row.event_id]).toEqual([null, null]);
    expect((await app.cancel(first.token)).status).toBe(200);
    app.signIn(host.id);
    expect((await app.cancelMine(String(second.row.id))).status).toBe(200);
    app.signOut();
    expect(app.bookingRows().every((r) => r.cancelled_at !== null)).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("cancels a booking that has an event with no request to Google", async () => {
    const b = await booked();
    inTheDemo();
    for (const route of ROUTE_NAMES) {
      const a = await ROUTES[route](b);
      expect(a.status, route).toBe(200);
    }
    expect(rowOf(b).cancelled_at).not.toBeNull();
    expect(fake.calls).toEqual([]);
  });
});
