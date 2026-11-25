import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyBookingLinks } from "@/lib/types";
import { at } from "./booking-reference";
import { bookingApp } from "./booking-helpers";
import { googleSide, inTheDemo, withGoogle, type GoogleHost } from "./booking-google-helpers";
import { failures, fakeGoogle, gate, waitFor, type Outcome } from "./google-fake";
import { captureConsole } from "./link-helpers";

// Booking links, part 2 (run 2026-11-19-ekip-booking-2), criterion 7: a
// sync read of the host's Google calendar that started after a booking's
// event was made, and doesn't have the event any more, cancels the booking.
// It counts every event the read returned, busy or not. And criterion 9: the
// sync still asks for no attendee list beyond attendees(self,responseStatus).
// Driven by sync.syncOne outside the demo, with Google behind a stubbed fetch.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "s".repeat(40);
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
const START = ist(19, 10, 30);
const GUEST = { name: "Sync Guest", email: "sync.guest@guests.example.org", note: "Sync note 5520" };

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
afterEach(() => {
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
async function booking(link: Parameters<typeof google.hostWithLink>[0] = {}, start = START): Promise<Booking> {
  const { host, id } = await google.hostWithLink(link);
  const { row } = await google.bookIt(id, start, GUEST);
  expect(row.event_id).toEqual(expect.any(String));
  expect(row.calendar_id).toBe(host.calendarId);
  return { host, id, bookingId: String(row.id), eventId: String(row.event_id), start };
}

const cancelledAt = (b: { bookingId: string }) => app.bookingRows().find((r) => r.id === b.bookingId)!.cancelled_at;

async function upcomingOf(host: GoogleHost) {
  app.signIn(host.id);
  const mine = (await app.myLinks()).json as MyBookingLinks;
  app.signOut();
  return mine.upcoming.map((u) => u.id);
}

/** The host deletes the booking's event in Google Calendar. */
const deleteEvent = (b: Booking) => google.deleteInGoogle(b.host.calendarId, b.eventId);

describe("a sync read that doesn't have the booking's event (criterion 7)", () => {
  it("cancels the booking and offers its time again", async () => {
    const b = await booking();
    expect(await app.startsOf(b.id)).not.toContain(b.start);
    setNow(NOW + MIN);
    deleteEvent(b);
    await sync.syncOne(b.host.id);
    expect(fake.of("events").length).toBeGreaterThan(0);
    expect(cancelledAt(b)).toEqual(expect.any(Number));
    expect(await upcomingOf(b.host)).toEqual([]);
    expect(await app.startsOf(b.id)).toContain(b.start);
    // Once cancelled it stays as it was.
    const when = cancelledAt(b);
    setNow(NOW + 2 * MIN);
    await sync.syncOne(b.host.id);
    expect(cancelledAt(b)).toBe(when);
  });

  it("cancels only the booking whose event is gone", async () => {
    const { host, id } = await google.hostWithLink();
    const gone = await google.bookIt(id, START, GUEST);
    const kept = await google.bookIt(id, ist(19, 11, 30), GUEST);
    setNow(NOW + MIN);
    google.deleteInGoogle(host.calendarId, String(gone.row.event_id));
    await sync.syncOne(host.id);
    expect(cancelledAt({ bookingId: String(gone.row.id) })).toEqual(expect.any(Number));
    expect(cancelledAt({ bookingId: String(kept.row.id) })).toBeNull();
  });
});

describe("a sync read that leaves the booking as it is (criterion 7)", () => {
  /** The event is still in the calendar, in one of these states. */
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
        const e = google.eventOf(b.host.calendarId, b.eventId);
        for (const a of e.attendees ?? []) if (a.self) a.responseStatus = "declined";
        expect(e.attendees?.some((a) => a.self && a.responseStatus === "declined")).toBe(true);
      },
    ],
    [
      "tentative, on the read's second page",
      (b) => {
        const list = fake.events.get(b.host.calendarId)!;
        google.eventOf(b.host.calendarId, b.eventId).status = "tentative";
        // An earlier event comes first, one event a page.
        list.unshift({ id: "first-on-page-one", status: "confirmed", start: { dateTime: new Date(NOW).toISOString() }, end: { dateTime: new Date(NOW + MIN).toISOString() } });
        fake.options.pageSize = 1;
      },
    ],
  ];

  it.each(stillThere)("keeps it while the read has its event, %s", async (_what, change) => {
    const b = await booking();
    setNow(NOW + MIN);
    change(b);
    await sync.syncOne(b.host.id);
    expect(fake.of("events").length).toBeGreaterThan(0);
    expect(cancelledAt(b)).toBeNull();
    expect(await upcomingOf(b.host)).toEqual([b.bookingId]);
  });

  const failedReads: [string, () => void][] = [
    ["the read answers 500", () => (fake.answer.events = failures.serverError)],
    ["the read answers 401", () => (fake.answer.events = failures.unauthorized)],
    ["Google can't be reached for the read", () => (fake.answer.events = (): Outcome => "network")],
    [
      "the token can't be refreshed",
      () => {
        // Changed in run 2026-11-21-ekip-booking-tokens: the booking kept its access
        // token (sync every minute), so drop it, and the sync asks Google for one.
        delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.google-tokens")];
        fake.answer.token = failures.tokenServerError;
      },
    ],
  ];

  it.each(failedReads)("keeps it when %s, though the event is gone", async (_what, fail) => {
    const b = await booking();
    setNow(NOW + MIN);
    deleteEvent(b);
    fail();
    await sync.syncOne(b.host.id);
    expect(cancelledAt(b)).toBeNull();
  });

  it("keeps it when the read started before the event was made, and cancels it at the next read without the event", async () => {
    const { host, id } = await google.hostWithLink();
    const held = gate();
    fake.answer.events = async () => {
      await held.opened;
      return undefined;
    };
    // The read starts...
    const reading = sync.syncOne(host.id);
    await waitFor(() => fake.of("events").length === 1, "the read to start");
    // ...a visitor books while it runs, so the read doesn't have the new event...
    setNow(NOW + 1000);
    const { row } = await google.bookIt(id, START, GUEST);
    // ...and the read ends after that.
    setNow(NOW + 2000);
    held.open();
    await reading;
    const b = { bookingId: String(row.id) };
    expect(cancelledAt(b)).toBeNull();

    // A read that starts later, after the host deleted the event.
    delete fake.answer.events;
    google.deleteInGoogle(host.calendarId, String(row.event_id));
    setNow(NOW + 3000);
    await sync.syncOne(host.id);
    expect(cancelledAt(b)).toBe(NOW + 3000);
  });

  it("keeps it when the time was held before the read started but the event was made after", async () => {
    const { host, id } = await google.hostWithLink();
    const making = gate();
    const reading = gate();
    fake.answer.insert = async () => {
      await making.opened;
      return undefined;
    };
    fake.answer.events = async () => {
      await reading.opened;
      return undefined;
    };
    // The booking holds the time now, and asks Google for the event.
    const booked = app.book(id, { start: START, ...GUEST });
    await waitFor(() => fake.of("insert").length === 1, "the event to be asked for");
    // A read starts.
    setNow(NOW + 1000);
    const read = sync.syncOne(host.id);
    await waitFor(() => fake.of("events").length === 1, "the read to start");
    // Google makes the event after the read started.
    setNow(NOW + 2000);
    making.open();
    expect((await booked).status).toBe(200);
    setNow(NOW + 3000);
    reading.open();
    await read;
    const [row] = app.bookingRows();
    expect(row.event_id).toEqual(expect.any(String));
    expect(row.cancelled_at).toBeNull();
  });

  it("keeps it when the event was made in the very millisecond the read started", async () => {
    const b = await booking();
    deleteEvent(b);
    // The clock hasn't moved: the read starts at the moment the event was made.
    await sync.syncOne(b.host.id);
    expect(cancelledAt(b)).toBeNull();
    setNow(NOW + 1);
    await sync.syncOne(b.host.id);
    expect(cancelledAt(b)).toBe(NOW + 1);
  });

  it("keeps it when the booking is on another calendar than the one read", async () => {
    const b = await booking();
    const team = "team-calendar@group.calendar.google.com";
    google.addCalendars(b.host, [{ id: team, summary: "Team", access: "events", included: true }]);
    setNow(NOW + MIN);
    deleteEvent(b);
    // The read of the booking's calendar fails; the other one is read.
    const calendarOf = (c: { url: URL }) => decodeURIComponent(c.url.pathname.split("/")[4]);
    fake.answer.events = (call) => (calendarOf(call) === b.host.calendarId ? failures.serverError() : undefined);
    await sync.syncOne(b.host.id);
    const reads = fake.of("events").map(calendarOf);
    expect(reads.sort()).toEqual([b.host.calendarId, team].sort());
    expect(cancelledAt(b)).toBeNull();
  });

  it("keeps it when its calendar is read only as free/busy, which lists no events", async () => {
    const b = await booking();
    const shared = "shared-freebusy@example.com";
    google.addCalendars(b.host, [{ id: shared, summary: "Shared", access: "freebusy", included: true }]);
    // A booking stored against that calendar (made up: bookings go on the primary).
    db.db().prepare("UPDATE bookings SET calendar_id = ? WHERE id = ?").run(shared, b.bookingId);
    setNow(NOW + MIN);
    await sync.syncOne(b.host.id);
    expect(fake.of("freeBusy").length, "the calendar was read").toBeGreaterThan(0);
    expect(cancelledAt(b)).toBeNull();
  });

  it("keeps a booking that has ended, though its event is gone", async () => {
    const b = await booking({}, ist(18, 10));
    setNow(ist(18, 10, 31));
    deleteEvent(b);
    await sync.syncOne(b.host.id);
    expect(fake.of("events").length).toBeGreaterThan(0);
    expect(cancelledAt(b)).toBeNull();
  });

  it("keeps a booking that starts outside the range read", async () => {
    // Booked 12 days ahead; then the server syncs only 7 days ahead.
    const b = await booking({ aheadDays: 14 }, ist(30, 10, 30));
    setNow(NOW + MIN);
    process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 7\n";
    await sync.syncOne(b.host.id);
    const [read] = fake.of("events");
    expect(Date.parse(read.url.searchParams.get("timeMax")!)).toBeLessThanOrEqual(b.start);
    expect(cancelledAt(b)).toBeNull();
    // Read over 30 days again, with the event gone.
    process.env.CONFIG_YAML = CONFIG;
    deleteEvent(b);
    setNow(NOW + 2 * MIN);
    await sync.syncOne(b.host.id);
    expect(cancelledAt(b)).toBe(NOW + 2 * MIN);
  });

  it("keeps a booking that has no event, made in the demo", async () => {
    inTheDemo();
    const { host, id } = await google.hostWithLink();
    const { row } = await google.bookIt(id, START, GUEST);
    expect(row.event_id).toBeNull();
    withGoogle();
    setNow(NOW + MIN);
    await sync.syncOne(host.id);
    expect(fake.of("events").length).toBeGreaterThan(0);
    expect(cancelledAt({ bookingId: String(row.id) })).toBeNull();
  });

  it("leaves another host's booking alone", async () => {
    const mine = await booking();
    const other = google.googleHost("Other Host");
    setNow(NOW + MIN);
    deleteEvent(mine);
    await sync.syncOne(other.id);
    expect(fake.of("events").length).toBeGreaterThan(0);
    expect(cancelledAt(mine)).toBeNull();
  });
});

describe("what the sync asks Google for (criterion 9)", () => {
  it("asks for no attendee list beyond attendees(self,responseStatus)", async () => {
    const b = await booking();
    setNow(NOW + MIN);
    await sync.syncOne(b.host.id);
    const reads = fake.of("events");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      const fields = r.url.searchParams.get("fields") ?? "";
      expect(fields).toContain("attendees(self,responseStatus)");
      expect(fields.replace("attendees(self,responseStatus)", "")).not.toMatch(/attendee/i);
    }
  });
});
