import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyBookingLinks } from "@/lib/types";
import { at } from "./booking-reference";
import { bookingApp } from "./booking-helpers";
import { googleSide, inTheDemo, withGoogle, type GoogleHost } from "./booking-google-helpers";
import { apiError, failures, fakeGoogle, gate, jsonResponse, shortTimeouts, waitFor, type Call, type Outcome } from "./google-fake";
import { captureConsole } from "./link-helpers";

// Booking links, part 2b (run 2026-11-19-ekip-booking-2b), criterion 5: when
// a successful sync read doesn't return a booking's event, and part 2's
// criterion 7 conditions hold, the app asks Google for that one event,
// GET calendars/<calendar_id>/events/<event_id>?fields=status, before it
// cancels anything. Only 404, 410 or status "cancelled" cancel the booking;
// anything else keeps it, and the next read asks again. There's no such GET
// for an event the read returned, after a failed read, or for a booking part
// 2's conditions leave out. Driven by sync.syncOne, Google a stubbed fetch.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "f".repeat(40);
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.APP_URL = "https://cal.example.com";
delete process.env.EXPOSURE;
withGoogle();

const app = await bookingApp(jar);
const { db, sync } = app;
const fake = fakeGoogle();
const google = googleSide(app, fake);

const ist = (d: number, h: number, m = 0) => at("Europe/Istanbul", 2026, 11, d, h, m);
const NOW = ist(18, 9);
const MIN = 60_000;
const DAY = 86_400_000;
const START = ist(19, 10, 30);
const GUEST = { name: "Confirm Guest", email: "confirm.guest@guests.example.org", note: "Confirm note 7290" };

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
afterEach(async () => {
  await fake.idle();
  timeouts?.mockRestore();
  timeouts = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.CONFIG_YAML = CONFIG;
  withGoogle();
  expect(fake.problems).toEqual([]);
  const log = lines.join("\n");
  for (const bit of [GUEST.name, GUEST.email, GUEST.note]) expect(log).not.toContain(bit);
});

type Booking = { host: GoogleHost; id: string; bookingId: string; eventId: string; start: number };

/** A booking made outside the demo at the current time, with its event on the host's primary calendar. */
async function booking(link: Parameters<typeof google.hostWithLink>[0] = {}, start = START, name = "Ilgaz Host"): Promise<Booking> {
  const { host, id } = await google.hostWithLink(link, { name });
  const { row } = await google.bookIt(id, start, GUEST);
  expect(row.event_id).toEqual(expect.any(String));
  expect(row.calendar_id).toBe(host.calendarId);
  return { host, id, bookingId: String(row.id), eventId: String(row.event_id), start };
}

const rowOf = (b: { bookingId: string }) => app.bookingRows().find((r) => r.id === b.bookingId)!;

async function upcomingOf(host: GoogleHost) {
  app.signIn(host.id);
  const mine = (await app.myLinks()).json as MyBookingLinks;
  app.signOut();
  return mine.upcoming.map((u) => u.id);
}

/** Each GET of one event: its call, its calendar and event (decoded). */
function gets() {
  return fake.of("get").map((call) => {
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(call.url.pathname);
    expect(m, call.url.pathname).not.toBeNull();
    return { call, calendarId: decodeURIComponent(m![1]), eventId: decodeURIComponent(m![2]) };
  });
}

/** The event a GET asks about. */
const eventOfCall = (call: Call) => decodeURIComponent(call.url.pathname.split("/").pop()!);

/** Expect exactly `n` GETs so far, each of this booking's event, as the criterion writes it. */
function expectGets(b: Booking, n: number) {
  const all = gets();
  expect(all).toHaveLength(n);
  for (const g of all) {
    expect(g.call.method).toBe("GET");
    expect([g.calendarId, g.eventId]).toEqual([b.host.calendarId, b.eventId]);
    expect(g.call.url.search).toBe("?fields=status");
    expect(g.call.account, "with the host's token").toBe(b.host.account);
  }
}

/** The host deletes the booking's event in Google Calendar. */
const deleteEvent = (b: Booking) => google.deleteInGoogle(b.host.calendarId, b.eventId);

describe("a read without the booking's event asks Google for that one event (criterion 5)", () => {
  it("sends one GET calendars/<calendar_id>/events/<event_id>?fields=status, with the host's token, after the read", async () => {
    const b = await booking();
    setNow(NOW + MIN);
    deleteEvent(b);
    await sync.syncOne(b.host.id);
    expectGets(b, 1);
    const [g] = gets();
    const read = fake.of("events").find((c) => decodeURIComponent(c.url.pathname.split("/")[4]) === b.host.calendarId)!;
    expect(fake.calls.indexOf(g.call)).toBeGreaterThan(fake.calls.indexOf(read));
  });

  const gone: [string, () => Outcome][] = [
    ["404", () => apiError(404, "notFound")],
    ["410", () => apiError(410, "deleted")],
    ["200 with status cancelled", () => jsonResponse(200, { status: "cancelled" })],
  ];

  it.each(gone)("cancels the booking when Google answers %s, and offers its time again", async (_what, answer) => {
    const b = await booking();
    setNow(NOW + MIN);
    deleteEvent(b);
    fake.answer.get = answer;
    await sync.syncOne(b.host.id);
    expectGets(b, 1);
    expect(rowOf(b).cancelled_at).toBe(NOW + MIN);
    expect(await upcomingOf(b.host)).toEqual([]);
    expect(await app.startsOf(b.id)).toContain(b.start);
    // Cancelled, it isn't asked about again.
    setNow(NOW + 2 * MIN);
    await sync.syncOne(b.host.id);
    expectGets(b, 1);
    expect(rowOf(b).cancelled_at).toBe(NOW + MIN);
  });

  const kept: [string, () => Outcome][] = [
    ["200 with status confirmed", () => jsonResponse(200, { status: "confirmed" })],
    ["200 with status tentative", () => jsonResponse(200, { status: "tentative" })],
    ["500", failures.serverError],
    ["a timeout", () => "timeout"],
    ["401", failures.unauthorized],
    ["no connection", () => "network"],
  ];

  it.each(kept)("keeps the booking unchanged when Google answers %s, and the next read asks again", async (what, answer) => {
    const b = await booking();
    const before = rowOf(b);
    setNow(NOW + MIN);
    deleteEvent(b);
    if (what === "a timeout") timeouts = shortTimeouts(30);
    fake.answer.get = answer;
    await sync.syncOne(b.host.id);
    expectGets(b, 1);
    expect(rowOf(b)).toEqual(before);
    expect(await upcomingOf(b.host)).toEqual([b.bookingId]);
    // Its time stays held, and the host's other times are still offered.
    const offered = await app.startsOf(b.id);
    expect(offered).not.toContain(b.start);
    expect(offered).toContain(ist(19, 11));
    // The next read asks again, and keeps it again.
    setNow(NOW + 2 * MIN);
    await sync.syncOne(b.host.id);
    expectGets(b, 2);
    expect(rowOf(b)).toEqual(before);
    // Once Google says it's gone, that read cancels it.
    timeouts?.mockRestore();
    timeouts = null;
    delete fake.answer.get;
    setNow(NOW + 3 * MIN);
    await sync.syncOne(b.host.id);
    expectGets(b, 3);
    expect(rowOf(b).cancelled_at).toBe(NOW + 3 * MIN);
  });

  it("keeps a booking whose event the host moved later, out of the range read: Google still has it", async () => {
    const b = await booking();
    setNow(NOW + MIN);
    const e = google.eventOf(b.host.calendarId, b.eventId);
    e.start = { dateTime: new Date(b.start + 60 * DAY).toISOString() };
    e.end = { dateTime: new Date(b.start + 60 * DAY + 30 * MIN).toISOString() };
    await sync.syncOne(b.host.id);
    const [read] = fake.of("events");
    expect(Date.parse(read.url.searchParams.get("timeMax")!), "moved past the range read").toBeLessThan(b.start + 60 * DAY);
    expectGets(b, 1);
    expect(rowOf(b).cancelled_at).toBeNull();
    expect(await upcomingOf(b.host)).toEqual([b.bookingId]);
  });

  it("keeps a booking whose event the host moved earlier, before the range read: Google still has it", async () => {
    const b = await booking();
    setNow(NOW + MIN);
    const e = google.eventOf(b.host.calendarId, b.eventId);
    e.start = { dateTime: new Date(NOW - 60 * DAY).toISOString() };
    e.end = { dateTime: new Date(NOW - 60 * DAY + 30 * MIN).toISOString() };
    await sync.syncOne(b.host.id);
    const [read] = fake.of("events");
    expect(Date.parse(read.url.searchParams.get("timeMin")!), "moved before the range read").toBeGreaterThan(NOW - 60 * DAY + 30 * MIN);
    expectGets(b, 1);
    expect(rowOf(b).cancelled_at).toBeNull();
  });

  it("keeps a booking when the list lags behind: the read leaves the event out, but Google has it", async () => {
    const b = await booking();
    setNow(NOW + MIN);
    fake.answer.events = () => jsonResponse(200, { items: [] });
    await sync.syncOne(b.host.id);
    expectGets(b, 1);
    expect(rowOf(b).cancelled_at).toBeNull();
  });

  it("asks once for each booking whose event is missing, and cancels only those Google says are gone", async () => {
    const { host, id } = await google.hostWithLink({}, { name: "Ilgaz Host" });
    const starts = { gone: ist(19, 10), there: ist(19, 10, 30), failing: ist(19, 11), inRead: ist(19, 11, 30) };
    const made = Object.fromEntries(
      await Promise.all(Object.entries(starts).map(async ([k, s]) => [k, (await google.bookIt(id, s, GUEST)).row] as const)),
    ) as Record<keyof typeof starts, Record<string, unknown>>;
    setNow(NOW + MIN);
    for (const k of ["gone", "there", "failing"] as const) google.deleteInGoogle(host.calendarId, String(made[k].event_id));
    fake.answer.get = (call) => {
      const event = eventOfCall(call);
      if (event === made.gone.event_id) return apiError(404, "notFound");
      if (event === made.there.event_id) return jsonResponse(200, { status: "confirmed" });
      return failures.serverError();
    };
    await sync.syncOne(host.id);
    expect(gets().map((g) => g.eventId).sort()).toEqual([made.gone.event_id, made.there.event_id, made.failing.event_id].map(String).sort());
    expect(rowOf({ bookingId: String(made.gone.id) }).cancelled_at).toBe(NOW + MIN);
    for (const k of ["there", "failing", "inRead"] as const) expect(rowOf({ bookingId: String(made[k].id) }), k).toEqual(made[k]);
  });
});

describe("no GET for an event the read returned (criterion 5)", () => {
  const stillThere: [string, (b: Booking) => void][] = [
    ["as it was made", () => {}],
    [
      "marked free (transparent)",
      (b) => {
        google.eventOf(b.host.calendarId, b.eventId).transparency = "transparent";
      },
    ],
    [
      "declined by the host",
      (b) => {
        for (const a of google.eventOf(b.host.calendarId, b.eventId).attendees ?? []) if (a.self) a.responseStatus = "declined";
      },
    ],
    [
      "tentative, on the read's second page",
      (b) => {
        google.eventOf(b.host.calendarId, b.eventId).status = "tentative";
        fake.events.get(b.host.calendarId)!.unshift({
          id: "firstonpageone",
          status: "confirmed",
          start: { dateTime: new Date(NOW).toISOString() },
          end: { dateTime: new Date(NOW + MIN).toISOString() },
        });
        fake.options.pageSize = 1;
      },
    ],
  ];

  it.each(stillThere)("with the event %s", async (_what, change) => {
    const b = await booking();
    setNow(NOW + MIN);
    change(b);
    await sync.syncOne(b.host.id);
    expect(fake.of("events").length).toBeGreaterThan(0);
    expect(fake.of("get")).toEqual([]);
    expect(rowOf(b).cancelled_at).toBeNull();
  });
});

describe("no GET after a failed read (criterion 5)", () => {
  const failedReads: [string, () => void][] = [
    ["the read answers 500", () => (fake.answer.events = failures.serverError)],
    ["the read answers 401", () => (fake.answer.events = failures.unauthorized)],
    ["Google can't be reached for the read", () => (fake.answer.events = (): Outcome => "network")],
    [
      "the read's second page fails",
      () => {
        fake.options.pageSize = 1;
        fake.answer.events = (call) => (call.url.searchParams.has("pageToken") ? failures.serverError() : undefined);
      },
    ],
  ];

  it.each(failedReads)("when %s, though the event is gone", async (what, fail) => {
    const b = await booking();
    setNow(NOW + MIN);
    if (what === "the read's second page fails") {
      // Two other events in the range, one a page: the read has a second page.
      fake.events.get(b.host.calendarId)!.unshift(
        ...["firstonpageone", "secondonpagetwo"].map((id, i) => ({
          id,
          status: "confirmed",
          start: { dateTime: new Date(NOW + i * MIN).toISOString() },
          end: { dateTime: new Date(NOW + (i + 1) * MIN).toISOString() },
        })),
      );
    }
    deleteEvent(b);
    fail();
    await sync.syncOne(b.host.id);
    if (what === "the read's second page fails") expect(fake.of("events").map((c) => c.url.searchParams.has("pageToken"))).toEqual([false, true]);
    expect(fake.of("get")).toEqual([]);
    expect(rowOf(b).cancelled_at).toBeNull();
  });
});

describe("no GET for a booking part 2's conditions leave out (criterion 5)", () => {
  it("when the event was made while the read was under way", async () => {
    const { host, id } = await google.hostWithLink({}, { name: "Ilgaz Host" });
    const held = gate();
    fake.answer.events = async () => {
      await held.opened;
      return undefined;
    };
    const reading = sync.syncOne(host.id);
    try {
      await waitFor(() => fake.of("events").length === 1, "the read to start");
      setNow(NOW + 1000);
      await google.bookIt(id, START, GUEST);
      setNow(NOW + 2000);
    } finally {
      held.open();
    }
    await reading;
    expect(fake.of("get")).toEqual([]);
    expect(app.bookingRows()[0].cancelled_at).toBeNull();
  });

  it("when the event was made in the very millisecond the read started", async () => {
    const b = await booking();
    deleteEvent(b);
    await sync.syncOne(b.host.id);
    expect(fake.of("get")).toEqual([]);
    expect(rowOf(b).cancelled_at).toBeNull();
  });

  it("when the booking is on another calendar than the one read", async () => {
    const b = await booking();
    const team = "team-calendar@group.calendar.google.com";
    google.addCalendars(b.host, [{ id: team, summary: "Team", access: "events", included: true }]);
    setNow(NOW + MIN);
    deleteEvent(b);
    const calendarOf = (c: { url: URL }) => decodeURIComponent(c.url.pathname.split("/")[4]);
    fake.answer.events = (call) => (calendarOf(call) === b.host.calendarId ? failures.serverError() : undefined);
    await sync.syncOne(b.host.id);
    expect(fake.of("events").map(calendarOf).sort()).toEqual([b.host.calendarId, team].sort());
    expect(fake.of("get")).toEqual([]);
    expect(rowOf(b).cancelled_at).toBeNull();
  });

  it("when its calendar is read only as free/busy", async () => {
    const b = await booking();
    const shared = "shared-freebusy@example.com";
    google.addCalendars(b.host, [{ id: shared, summary: "Shared", access: "freebusy", included: true }]);
    db.db().prepare("UPDATE bookings SET calendar_id = ? WHERE id = ?").run(shared, b.bookingId);
    setNow(NOW + MIN);
    await sync.syncOne(b.host.id);
    expect(fake.of("freeBusy").length).toBeGreaterThan(0);
    expect(fake.of("get")).toEqual([]);
    expect(rowOf(b).cancelled_at).toBeNull();
  });

  it("when the booking has ended", async () => {
    const b = await booking({}, ist(18, 10));
    setNow(ist(18, 10, 31));
    deleteEvent(b);
    await sync.syncOne(b.host.id);
    expect(fake.of("events").length).toBeGreaterThan(0);
    expect(fake.of("get")).toEqual([]);
    expect(rowOf(b).cancelled_at).toBeNull();
  });

  it("when the booking starts outside the range read", async () => {
    const b = await booking({ aheadDays: 14 }, ist(30, 10, 30));
    setNow(NOW + MIN);
    process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 7\n";
    deleteEvent(b);
    await sync.syncOne(b.host.id);
    const [read] = fake.of("events");
    expect(Date.parse(read.url.searchParams.get("timeMax")!)).toBeLessThanOrEqual(b.start);
    expect(fake.of("get")).toEqual([]);
    expect(rowOf(b).cancelled_at).toBeNull();
  });

  it("when the booking has no event (made in the demo)", async () => {
    inTheDemo();
    const { host, id } = await google.hostWithLink({}, { name: "Ilgaz Host" });
    const { row } = await google.bookIt(id, START, GUEST);
    expect(row.event_id).toBeNull();
    withGoogle();
    setNow(NOW + 3 * MIN);
    await sync.syncOne(host.id);
    expect(fake.of("events").length).toBeGreaterThan(0);
    expect(fake.of("get")).toEqual([]);
  });

  it("when the booking is another host's, though this host counts its calendar too", async () => {
    const mine = await booking();
    const other = google.googleHost("Other Host");
    // The booking's calendar is shared with the other host, who counts it.
    google.addCalendars(other, [{ id: mine.host.calendarId, summary: "Shared", access: "events", included: true }]);
    setNow(NOW + MIN);
    deleteEvent(mine);
    await sync.syncOne(other.id);
    const calendarOf = (c: { url: URL }) => decodeURIComponent(c.url.pathname.split("/")[4]);
    expect(fake.of("events").map(calendarOf)).toContain(mine.host.calendarId);
    expect(fake.of("get")).toEqual([]);
    expect(rowOf(mine).cancelled_at).toBeNull();
  });

  it("when the booking was cancelled already", async () => {
    const b = await booking();
    setNow(NOW + MIN);
    app.signIn(b.host.id);
    expect((await app.cancelMine(b.bookingId)).status).toBe(200);
    app.signOut();
    expect(fake.of("delete")).toHaveLength(1);
    setNow(NOW + 2 * MIN);
    await sync.syncOne(b.host.id);
    expect(fake.of("events").length).toBeGreaterThan(0);
    expect(fake.of("get")).toEqual([]);
    expect(rowOf(b).cancelled_at).toBe(NOW + MIN);
  });
});
