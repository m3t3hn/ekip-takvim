import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { at } from "./booking-reference";
import { TAKEN, bookingApp, type Answer } from "./booking-helpers";
import { googleSide, withGoogle, type GoogleHost } from "./booking-google-helpers";
import { fakeGoogle, gate, waitFor } from "./google-fake";
import { captureConsole } from "./link-helpers";

// Booking links, part 2b (run 2026-11-19-ekip-booking-2b), criterion 6: after
// POST /api/book/[id] answers 409 because the live free/busy check found the
// time busy, a sync of that host starts in the background. The 409 doesn't
// wait for it, even while its requests hang. At most one such sync a minute
// per host. Once it has stored the busy time, GET /api/book/[id] no longer
// offers that time. Outside the demo, with Google behind a stubbed fetch.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "b".repeat(40);
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
const VISITOR = { name: "Busy Visitor", email: "busy.visitor@guests.example.org", note: "Busy note 1202" };

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
  for (const bit of [VISITOR.name, VISITOR.email, VISITOR.note]) expect(log).not.toContain(bit);
});

const iso = (t: number) => new Date(t).toISOString();

/** How many syncs of this host have run: each one reads the host's calendar list from Google. */
const syncsOf = (host: GoogleHost) => fake.of("calendarList").filter((c) => c.account === host.account).length;

/** Book `start` and expect the live check's 409; then let any sync it started finish. */
async function takenAt(id: string, start: number, at: number) {
  setNow(at);
  const before = fake.of("freeBusy").length;
  const a = await app.book(id, { start, ...VISITOR });
  expect([a.status, a.json]).toEqual([409, TAKEN]);
  expect(fake.of("freeBusy").length, "the live check ran").toBeGreaterThan(before);
  expect(fake.of("insert")).toEqual([]);
  await fake.idle();
}

describe("a 409 from the live free/busy check (criterion 6)", () => {
  it("starts a sync of that host in the background, answers without waiting for it while its requests hang, and once it stored the busy time the time isn't offered", async () => {
    const { host, id } = await google.hostWithLink({}, { name: "Busy Host" });
    const other = await google.hostWithLink({}, { name: "Calm Host" });
    // Google has an event over START that the app hasn't read yet.
    fake.events.get(host.calendarId)!.push({
      id: "unseenmeeting1",
      status: "confirmed",
      summary: "Unseen meeting",
      start: { dateTime: iso(START - 10 * MIN) },
      end: { dateTime: iso(START + 20 * MIN) },
    });
    expect(await app.startsOf(id)).toContain(START);

    // Every request the sync makes hangs until the test lets it go: its token
    // (any after the booking's own free/busy check), calendar list and reads.
    const held = gate();
    const hang = async () => {
      await held.opened;
      return undefined;
    };
    fake.answer.token = () => (fake.of("freeBusy").length > 0 ? hang() : undefined);
    fake.answer.calendarList = hang;
    fake.answer.events = hang;

    let a: Answer | "still waiting";
    const booking = app.book(id, { start: START, ...VISITOR });
    try {
      a = await Promise.race([booking, new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 2000))]);
      expect(a, "the 409 came without waiting for the sync").not.toBe("still waiting");
      expect([(a as Answer).status, (a as Answer).json]).toEqual([409, TAKEN]);
      expect(fake.of("insert")).toEqual([]);
      // The sync has started. Changed in run 2026-11-21-ekip-booking-tokens: it uses
      // the token the booking kept (sync every minute) and asks for none, so its
      // first request, the calendar list, is the one waiting for Google.
      await waitFor(() => fake.of("calendarList").length === 1, "the sync to ask for the calendar list");
      expect(fake.of("token")).toHaveLength(1);
      expect(fake.of("events")).toEqual([]);
      expect(await app.startsOf(id), "still offered while the sync waits").toContain(START);
    } finally {
      held.open();
      await booking;
    }
    await fake.idle();
    // The sync read that host's calendars, and no one else's.
    expect(syncsOf(host)).toBe(1);
    expect(fake.of("calendarList").every((c) => c.account === host.account)).toBe(true);
    expect(fake.of("events").every((c) => c.account === host.account)).toBe(true);
    expect(syncsOf(other.host)).toBe(0);
    // It stored the busy time: the time isn't offered any more.
    expect(db.busyBetween(START, START + 30 * MIN, host.id)).toHaveLength(1);
    expect(await app.startsOf(id)).not.toContain(START);
  });

  it("starts no second sync for the same host within a minute, and one more after it", async () => {
    const { host, id } = await google.hostWithLink({}, { name: "Busy Host" });
    // Google says these times are busy, for a reason its event reads don't show,
    // so a sync doesn't stop them being offered and each try reaches the live check.
    const slots = [ist(19, 10), ist(19, 10, 30), ist(19, 11), ist(19, 11, 30)];
    fake.busy.set(
      host.calendarId,
      slots.map((s) => ({ start: s + 5 * MIN, end: s + 10 * MIN })),
    );
    const T = NOW + 7;
    await takenAt(id, slots[0], T);
    expect(syncsOf(host)).toBe(1);
    await takenAt(id, slots[1], T + 1);
    expect(syncsOf(host)).toBe(1);
    await takenAt(id, slots[2], T + 30_000);
    expect(syncsOf(host)).toBe(1);
    await takenAt(id, slots[3], T + 59_999);
    expect(syncsOf(host)).toBe(1);
    await takenAt(id, slots[0], T + 60_000);
    expect(syncsOf(host)).toBe(2);
    await takenAt(id, slots[1], T + 60_000 + 59_999);
    expect(syncsOf(host)).toBe(2);
    await takenAt(id, slots[2], T + 120_001);
    expect(syncsOf(host)).toBe(3);
    // Every sync was that host's.
    expect(fake.of("calendarList").every((c) => c.account === host.account)).toBe(true);
  });

  it("counts the minute per host", async () => {
    const first = await google.hostWithLink({}, { name: "First Host" });
    const second = await google.hostWithLink({}, { name: "Second Host" });
    for (const h of [first, second]) fake.busy.set(h.host.calendarId, [{ start: START, end: START + 30 * MIN }]);
    await takenAt(first.id, START, NOW);
    expect([syncsOf(first.host), syncsOf(second.host)]).toEqual([1, 0]);
    await takenAt(second.id, START, NOW + 1000);
    expect([syncsOf(first.host), syncsOf(second.host)]).toEqual([1, 1]);
    await takenAt(first.id, START, NOW + 2000);
    await takenAt(second.id, START, NOW + 3000);
    expect([syncsOf(first.host), syncsOf(second.host)]).toEqual([1, 1]);
  });
});
