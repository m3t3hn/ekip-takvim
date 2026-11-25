import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyBookingLinks } from "@/lib/types";
import { at } from "./booking-reference";
import { bookingApp } from "./booking-helpers";
import { BEING_MADE, googleSide, inTheDemo, withGoogle, type GoogleHost, type MadeWithInvite } from "./booking-google-helpers";
import { fakeGoogle, gate, waitFor } from "./google-fake";
import { captureConsole } from "./link-helpers";

// Booking links, part 2b (run 2026-11-19-ekip-booking-2b), criterion 1:
// outside the demo, a booking with no event yet, made less than 2 minutes
// ago, is still being made. Cancelling it by its cancel link
// (POST /api/book/cancel/[token]) or by its host
// (POST /api/me/bookings/[id]/cancel) answers 409, asks Google nothing and
// changes nothing. Once its event is made, a cancel deletes the event as in
// part 2. One without an event that's 2 minutes old or more is cancelled with
// no call to Google, and the demo cancels as before. Google is a stubbed fetch.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "m".repeat(40);
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
const GUEST = { name: "Making Guest", email: "making.guest@guests.example.org", note: "Making note 6613" };

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
  await fake.idle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  withGoogle();
  expect(fake.problems).toEqual([]);
  const log = lines.join("\n");
  for (const bit of [GUEST.name, GUEST.email, GUEST.note]) expect(log).not.toContain(bit);
});

type Held = { host: GoogleHost; id: string; token: string; bookingId: string; row: Record<string, unknown> };

/**
 * A booking with no event, made at NOW: booked in the demo, which makes no
 * event, after which the server runs outside the demo. The calls so far are
 * forgotten.
 */
async function withoutEvent(): Promise<Held> {
  inTheDemo();
  const { host, id } = await google.hostWithLink({ title: "Planning" }, { name: "Deniz Host" });
  const { token, row } = await google.bookIt(id, START, GUEST);
  expect(row.event_id).toBeNull();
  expect(row.created_at).toBe(NOW);
  withGoogle();
  fake.calls.length = 0;
  return { host, id, token, bookingId: String(row.id), row };
}

const rowOf = (b: { bookingId: string }) => app.bookingRows().find((r) => r.id === b.bookingId);

/** The host's upcoming bookings, by id. */
async function upcomingOf(host: GoogleHost) {
  app.signIn(host.id);
  try {
    return ((await app.myLinks()).json as MyBookingLinks).upcoming.map((u) => u.id);
  } finally {
    app.signOut();
  }
}

/** The host cancels a booking of theirs. */
async function hostCancels(host: GoogleHost, bookingId: string) {
  app.signIn(host.id);
  try {
    return await app.cancelMine(bookingId);
  } finally {
    app.signOut();
  }
}

/** The two ways to cancel. */
const ROUTES = {
  "the cancel link": (b: { token: string }) => app.cancel(b.token),
  "the host": (b: { host: GoogleHost; bookingId: string }) => hostCancels(b.host, b.bookingId),
};
type Route = keyof typeof ROUTES;
const ROUTE_NAMES = Object.keys(ROUTES) as Route[];

/** Part 1's answer for a cancelled booking, by route. */
function expectCancelled(route: Route, b: Held, a: { status: number; json: unknown }) {
  expect(a.status).toBe(200);
  if (route === "the cancel link") {
    expect(a.json).toEqual({ title: "Planning", start: START, end: START + 30 * MIN, hostName: "Deniz Host", cancelled: true, ended: false, bookAgain: `/book/${b.id}` });
  } else {
    const mine = a.json as MyBookingLinks;
    expect(mine.upcoming).toEqual([]);
    expect(mine.links.map((l) => l.id)).toEqual([b.id]);
  }
}

/** The one DELETE sent: its calendar and event, decoded. */
function theDelete() {
  const deletes = fake.of("delete");
  expect(deletes).toHaveLength(1);
  const [call] = deletes;
  const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(call.url.pathname);
  expect(m, call.url.pathname).not.toBeNull();
  return { call, calendarId: decodeURIComponent(m![1]), eventId: decodeURIComponent(m![2]) };
}

describe("a booking without an event, made less than 2 minutes ago, outside the demo (criterion 1)", () => {
  const AGES: [string, number][] = [
    ["at once", 0],
    ["1 ms", 1],
    ["30 s", 30_000],
    ["1 min", MIN],
    ["2 min - 1 ms", 2 * MIN - 1],
  ];
  const cases = ROUTE_NAMES.flatMap((route) => AGES.map(([when, age]) => [route, when, age] as const));

  it.each(cases)("by %s, %s after it was made: 409 'still being made', no call to Google, and the booking as it was", async (route, _when, age) => {
    const b = await withoutEvent();
    setNow(NOW + age);
    const a = await ROUTES[route](b);
    expect([a.status, a.json]).toEqual([409, BEING_MADE]);
    expect(fake.calls).toEqual([]);
    expect(rowOf(b)).toEqual(b.row);
    // Still the host's booking, still holding its time; the host's other times are offered.
    expect(await upcomingOf(b.host)).toEqual([b.bookingId]);
    const offered = await app.startsOf(b.id);
    expect(offered).not.toContain(START);
    expect(offered).toContain(ist(19, 11));
    expect(fake.calls).toEqual([]);
  });
});

describe("a booking without an event, made 2 minutes ago or more, outside the demo (criterion 1)", () => {
  const AGES: [string, number][] = [
    ["exactly 2 min", 2 * MIN],
    ["2 min + 1 ms", 2 * MIN + 1],
    ["10 min", 10 * MIN],
    ["3 hours", 180 * MIN],
  ];
  const cases = ROUTE_NAMES.flatMap((route) => AGES.map(([when, age]) => [route, when, age] as const));

  it.each(cases)("by %s, %s after it was made: cancelled with no call to Google, and its time offered again", async (route, _when, age) => {
    const b = await withoutEvent();
    setNow(NOW + age);
    const a = await ROUTES[route](b);
    expectCancelled(route, b, a);
    expect(rowOf(b)!.cancelled_at).toBe(NOW + age);
    expect(fake.calls).toEqual([]);
    expect(await app.startsOf(b.id)).toContain(START);
  });
});

describe("the demo (criterion 1)", () => {
  it.each(ROUTE_NAMES)("by %s: a booking without an event, made at this moment, is cancelled as before, with no call to Google", async (route) => {
    const b = await withoutEvent();
    inTheDemo();
    const a = await ROUTES[route](b);
    expectCancelled(route, b, a);
    expect(rowOf(b)!.cancelled_at).toBe(NOW);
    expect(fake.calls).toEqual([]);
  });
});

describe("while Google makes the booking's event, and once it's made (criterion 1)", () => {
  /** A visitor books START while Google holds the insert; the booking as stored meanwhile. */
  async function bookingUnderWay() {
    const { host, id } = await google.hostWithLink({ title: "Planning" }, { name: "Deniz Host" });
    const making = gate();
    fake.answer.insert = async () => {
      await making.opened;
      return undefined;
    };
    const booking = app.book(id, { start: START, ...GUEST });
    await waitFor(() => fake.of("insert").length === 1, "the event to be asked for");
    const rows = app.bookingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBeNull();
    return { host, id, booking, making, held: rows[0] };
  }

  it("the host can't cancel it while the insert is under way: 409, no call to Google, the booking as it was; the visitor's booking then goes through", async () => {
    const { host, booking, making, held } = await bookingUnderWay();
    try {
      setNow(NOW + 20_000);
      const before = fake.calls.length;
      const a = await hostCancels(host, String(held.id));
      expect([a.status, a.json]).toEqual([409, BEING_MADE]);
      expect(fake.calls.length, "no call to Google").toBe(before);
      expect(app.bookingRows()).toEqual([held]);
    } finally {
      making.open();
    }
    const made = await booking;
    expect(made.status, made.text).toBe(200);
    expect((made.json as MadeWithInvite).invited).toBe(true);
    const [row] = app.bookingRows();
    expect(row.cancelled_at).toBeNull();
    expect(row.event_id).toBe(fake.made[0]);
    expect(fake.of("delete")).toEqual([]);
  });

  it.each(ROUTE_NAMES)("by %s: once the event is made, the same request deletes it, as in part 2, though the booking is less than 2 minutes old", async (route) => {
    const { host, id, booking, making, held } = await bookingUnderWay();
    try {
      expect((await hostCancels(host, String(held.id))).status).toBe(409);
    } finally {
      making.open();
    }
    const made = await booking;
    expect(made.status, made.text).toBe(200);
    const token = new URL((made.json as MadeWithInvite).cancelUrl).pathname.split("/").pop()!;
    const [row] = app.bookingRows();
    expect(row.event_id).toEqual(expect.any(String));
    const b: Held = { host, id, token, bookingId: String(row.id), row };

    fake.calls.length = 0;
    setNow(NOW + 30_000);
    const a = await ROUTES[route](b);
    expectCancelled(route, b, a);
    const del = theDelete();
    expect([del.calendarId, del.eventId]).toEqual([row.calendar_id, row.event_id]);
    expect(del.call.url.searchParams.get("sendUpdates")).toBe("all");
    expect(del.call.account, "with the host's token").toBe(host.account);
    expect(fake.events.get(host.calendarId)!.map((e) => e.id)).not.toContain(row.event_id);
    expect(rowOf(b)!.cancelled_at).toBe(NOW + 30_000);
    expect(await app.startsOf(id)).toContain(START);
  });

  it.each(ROUTE_NAMES)("by %s: a booking whose event was made at this very moment is cancelled with one DELETE, not 409", async (route) => {
    const { host, id } = await google.hostWithLink({ title: "Planning" }, { name: "Deniz Host" });
    const { token, row } = await google.bookIt(id, START, GUEST);
    expect(row.created_at).toBe(NOW);
    expect(row.event_id).toEqual(expect.any(String));
    fake.calls.length = 0;
    const b: Held = { host, id, token, bookingId: String(row.id), row };
    const a = await ROUTES[route](b);
    expectCancelled(route, b, a);
    const del = theDelete();
    expect([del.calendarId, del.eventId]).toEqual([row.calendar_id, row.event_id]);
    expect(rowOf(b)!.cancelled_at).toBe(NOW);
  });
});
