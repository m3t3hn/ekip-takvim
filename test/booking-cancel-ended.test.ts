import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingToCancel, MyBookingLinks } from "@/lib/types";
import { at } from "./booking-reference";
import { BOOKING_OFF, LINK, bookingApp, type Answer } from "./booking-helpers";
import { googleSide, inTheDemo, withGoogle, type GoogleHost } from "./booking-google-helpers";
import { fakeGoogle } from "./google-fake";
import { captureConsole } from "./link-helpers";

// Booking links' quick wins (run 2026-11-25-ekip-quick-wins-visitor),
// criterion 6, the server's side:
// - Cancelling a booking whose meeting has ended is refused, by the cancel
//   link's POST and by the host's cancel alike: the booking stays as it is,
//   and nothing is asked of Google or deleted there.
// - The cancel link's answers say whether the meeting has ended, and give
//   "Book another time" (the booking link's page) after cancelling, on a
//   cancelled booking and on an ended one, while that link is on and its host
//   is still here; otherwise none.
// - One tap still cancels an upcoming booking (team question 8).
// Outside the demo, Google is google-fake.ts behind a stubbed fetch; in the
// demo, fetch answers nothing. Nothing reaches the network.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "e".repeat(40);
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
/** Wednesday 18 Nov 2026, 09:00 in Istanbul. */
const NOW = ist(18, 9);
const MIN = 60_000;
const START = ist(19, 10, 30);
const END = START + 30 * MIN;
const GUEST = { name: "Ended Guest", email: "ended.guest@guests.example.org", note: "Ended note 5521" };
const ENDED = { error: "This meeting has ended, so it can't be cancelled." };

const setNow = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};

let lines: string[] = [];
const tokens: string[] = [];

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
  process.env.BOOKING_LINKS = "on";
  process.env.CONFIG_YAML = CONFIG;
  withGoogle();
  expect(fake.problems).toEqual([]);
  // The log never holds a cancel link, or the guest's details.
  const log = lines.join("\n");
  for (const bit of [...tokens, GUEST.name, GUEST.email, GUEST.note]) expect(log).not.toContain(bit);
});

type Booked = { host: GoogleHost; id: string; token: string; bookingId: string; eventId: string; calendarId: string };

/** A booking made outside the demo, with its Google event, for 19 Nov 10:30-11:00; the calls so far are forgotten. */
async function booked(body: Partial<typeof LINK> = {}): Promise<Booked> {
  const { host, id } = await google.hostWithLink({ title: "Design review", ...body }, { name: "Mert Host" });
  const { token, row } = await google.bookIt(id, START, GUEST);
  tokens.push(token);
  expect(row.event_id, "an event").toEqual(expect.any(String));
  google.eventOf(host.calendarId, row.event_id);
  fake.calls.length = 0;
  return { host, id, token, bookingId: String(row.id), eventId: String(row.event_id), calendarId: String(row.calendar_id) };
}

const rowOf = (b: { bookingId: string }) => app.bookingRows().find((r) => r.id === b.bookingId)!;
const byHost = async (b: Booked) => {
  app.signIn(b.host.id);
  try {
    return await app.cancelMine(b.bookingId);
  } finally {
    app.signOut();
  }
};
const ROUTES = {
  "the cancel link": (b: Booked) => app.cancel(b.token),
  "the host": byHost,
} as const;
type Route = keyof typeof ROUTES;
const ROUTE_NAMES = Object.keys(ROUTES) as Route[];

/** The booking's row and its Google event, to check they stay as they are. */
const snapshot = (b: Booked) => ({ row: { ...rowOf(b) }, events: JSON.stringify(fake.events.get(b.calendarId)) });

const shown = (b: Booked, more: Partial<BookingToCancel>): BookingToCancel => ({
  title: "Design review",
  start: START,
  end: END,
  hostName: "Mert Host",
  cancelled: false,
  ended: false,
  bookAgain: null,
  ...more,
});

describe("a booking whose meeting has ended can't be cancelled", () => {
  for (const route of ROUTE_NAMES) {
    for (const [when, t] of [
      ["right as it ends", END],
      ["a minute after", END + MIN],
      ["a week after", END + 7 * 24 * 60 * MIN],
    ] as const) {
      it(`by ${route}, ${when}: 409, the booking and its event stay, and Google isn't asked`, async () => {
        const b = await booked();
        setNow(t);
        const before = snapshot(b);
        const a: Answer = await ROUTES[route](b);
        expect([a.status, a.json]).toEqual([409, ENDED]);
        expect(fake.calls).toEqual([]);
        expect(snapshot(b)).toEqual(before);
        expect(rowOf(b).cancelled_at).toBeNull();
        google.eventOf(b.calendarId, b.eventId);
        // Pressing again is refused the same way.
        expect([(await ROUTES[route](b)).status, fake.calls.length]).toEqual([409, 0]);
      });
    }

    it(`by ${route}, 1 ms before it ends: cancelled as before, its event deleted`, async () => {
      const b = await booked();
      setNow(END - 1);
      const a = await ROUTES[route](b);
      expect(a.status, a.text).toBe(200);
      expect(rowOf(b).cancelled_at).toBe(END - 1);
      expect(fake.of("delete")).toHaveLength(1);
    });

    it(`by ${route}, while the meeting is on: cancelled as before`, async () => {
      const b = await booked();
      setNow(START + 10 * MIN);
      expect((await ROUTES[route](b)).status).toBe(200);
      expect(rowOf(b).cancelled_at).toBe(START + 10 * MIN);
      expect(fake.of("delete")).toHaveLength(1);
    });
  }

  it("in the demo too, by either route, with no request to anyone", async () => {
    inTheDemo();
    const fetches = vi.fn();
    vi.stubGlobal("fetch", async (input: unknown) => {
      fetches(input);
      throw new TypeError("test: no network");
    });
    const host = app.person("Demo Host");
    app.signIn(host.id);
    const id = await app.newLink({ title: "Demo call" });
    app.signOut();
    const token = await app.bookAs(id, START, "demo-ended");
    tokens.push(token);
    const bookingId = String(app.bookingRows()[0].id);
    setNow(END);
    expect([(await app.cancel(token)).status, (await app.cancel(token)).json]).toEqual([409, ENDED]);
    app.signIn(host.id);
    const mine = await app.cancelMine(bookingId);
    app.signOut();
    expect([mine.status, mine.json]).toEqual([409, ENDED]);
    expect(app.bookingRows()[0].cancelled_at).toBeNull();
    expect(fetches).not.toHaveBeenCalled();
  });

  it("a booking cancelled before it ended stays cancelled, answered as before, with nothing asked of Google", async () => {
    const b = await booked();
    setNow(NOW + MIN);
    expect((await app.cancel(b.token)).status).toBe(200);
    fake.calls.length = 0;
    setNow(END + MIN);
    for (const route of ROUTE_NAMES) expect((await ROUTES[route](b)).status, route).toBe(200);
    expect(fake.calls).toEqual([]);
    expect(rowOf(b).cancelled_at).toBe(NOW + MIN);
  });

  it("with BOOKING_LINKS off, an ended booking's visitor routes answer 404, and the host's what it answered before", async () => {
    const b = await booked();
    setNow(END + MIN);
    process.env.BOOKING_LINKS = "off";
    expect((await app.cancelInfo(b.token)).status).toBe(404);
    expect((await app.cancel(b.token)).status).toBe(404);
    const host = await byHost(b);
    expect([host.status, host.json]).toEqual([403, BOOKING_OFF]);
    expect(fake.calls).toEqual([]);
    expect(rowOf(b).cancelled_at).toBeNull();
  });
});

describe("one tap still cancels an upcoming booking (team question 8)", () => {
  it("a POST to the cancel link with nothing else cancels it", async () => {
    const b = await booked();
    setNow(NOW + 5 * MIN);
    const a = await app.cancel(b.token);
    expect(a.status, a.text).toBe(200);
    expect(a.json).toEqual(shown(b, { cancelled: true, bookAgain: `/book/${b.id}` }));
    expect(rowOf(b).cancelled_at).toBe(NOW + 5 * MIN);
  });
});

describe("what the cancel link's answers say: ended, and Book another time", () => {
  it("an upcoming booking: not ended, and no Book another time", async () => {
    const b = await booked();
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, {}));
    // While the meeting is on, it hasn't ended.
    setNow(START + MIN);
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, {}));
  });

  it("an ended booking: ended, with Book another time to its link's page while the link is on", async () => {
    const b = await booked();
    setNow(END);
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, { ended: true, bookAgain: `/book/${b.id}` }));
    setNow(END - 1);
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, {}));
  });

  it("after cancelling, and on a cancelled booking's page: Book another time while the link is on", async () => {
    const b = await booked();
    const a = await app.cancel(b.token);
    expect(a.json).toEqual(shown(b, { cancelled: true, bookAgain: `/book/${b.id}` }));
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, { cancelled: true, bookAgain: `/book/${b.id}` }));
    // Once its time has passed too.
    setNow(END + MIN);
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, { cancelled: true, ended: true, bookAgain: `/book/${b.id}` }));
  });

  it("after the host cancels: the same", async () => {
    const b = await booked();
    expect((await byHost(b)).status).toBe(200);
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, { cancelled: true, bookAgain: `/book/${b.id}` }));
  });

  it("no Book another time once the link is off, and again once it's back on", async () => {
    const b = await booked();
    await app.cancel(b.token);
    app.signIn(b.host.id);
    expect((await app.updateLink(b.id, { ...LINK, title: "Design review", active: false })).status).toBe(200);
    app.signOut();
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, { cancelled: true, bookAgain: null }));
    setNow(END + MIN);
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, { cancelled: true, ended: true, bookAgain: null }));
    app.signIn(b.host.id);
    expect((await app.updateLink(b.id, { ...LINK, title: "Design review", active: true })).status).toBe(200);
    app.signOut();
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, { cancelled: true, ended: true, bookAgain: `/book/${b.id}` }));
  });

  it("no Book another time for an ended booking whose link is off", async () => {
    const b = await booked();
    app.signIn(b.host.id);
    expect((await app.updateLink(b.id, { ...LINK, title: "Design review", active: false })).status).toBe(200);
    app.signOut();
    setNow(END);
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, { ended: true, bookAgain: null }));
  });

  it("no Book another time once the link is deleted", async () => {
    const b = await booked();
    app.signIn(b.host.id);
    expect((await app.deleteLink(b.id)).status).toBe(200);
    app.signOut();
    // The booking stays, without its link.
    expect(rowOf(b).link_id).toBeNull();
    const a = await app.cancel(b.token);
    expect(a.json).toEqual(shown(b, { cancelled: true, bookAgain: null }));
    setNow(END + MIN);
    expect((await app.cancelInfo(b.token)).json).toEqual(shown(b, { cancelled: true, ended: true, bookAgain: null }));
  });

  it("once the host left, there's no booking to show, so no Book another time", async () => {
    const b = await booked();
    await app.cancel(b.token);
    db.deleteUser(b.host.id);
    const a = await app.cancelInfo(b.token);
    expect([a.status, a.json]).toEqual([404, { error: "No booking matches this cancel link." }]);
    expect(a.text).not.toContain("/book/");
  });

  it("the page to book again is the link's own, on this site, and holds nothing else", async () => {
    const b = await booked();
    await app.cancel(b.token);
    const again = ((await app.cancelInfo(b.token)).json as BookingToCancel).bookAgain!;
    expect(again).toBe(`/book/${b.id}`);
    expect(again).not.toContain(b.token);
    expect(again).not.toMatch(/^https?:|^\/\//);
    // The host's own list, unchanged in shape.
    app.signIn(b.host.id);
    const mine = (await app.myLinks()).json as MyBookingLinks;
    app.signOut();
    expect(mine.upcoming).toEqual([]);
  });
});
