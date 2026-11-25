import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { at } from "./booking-reference";
import { CANT_BOOK, bookingApp } from "./booking-helpers";
import { googleSide, withGoogle, type GoogleHost } from "./booking-google-helpers";
import { apiError, failures, fakeGoogle, gate, shortTimeouts, waitFor, type Call, type Outcome } from "./google-fake";
import { captureConsole } from "./link-helpers";

// Booking links, part 2b (run 2026-11-19-ekip-booking-2b), POST /api/book/[id]
// outside the demo, with Google behind a stubbed fetch:
// - Criterion 2: a booking deleted or cancelled while its insert is under way
//   gets no event: the event just made is deleted again, and the visitor gets 503.
// - Criterion 3: the insert sends the event's own id, the booking's id without
//   dashes. An insert whose outcome is unknown (a timeout, no connection, 5xx)
//   is followed by one DELETE of that id; a 4xx one by none. That DELETE's own
//   failure is one warn line, with the host's and the event's ids.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "k".repeat(40);
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.APP_URL = "https://cal.example.com";
delete process.env.EXPOSURE;
withGoogle();

const app = await bookingApp(jar);
const { db } = app;
const meRoute = await import("@/app/api/me/route");
const fake = fakeGoogle();
const google = googleSide(app, fake);

const ist = (d: number, h: number, m = 0) => at("Europe/Istanbul", 2026, 11, d, h, m);
const NOW = ist(18, 9);
const START = ist(19, 10, 30);
/** The visitor. Their name, email and note never reach a log line. */
const VISITOR = { name: "Orla Vantage", email: "orla.vantage@guests.example.org", note: "Cleanup note 3307: bring the slides" };

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
  withGoogle();
  expect(fake.problems).toEqual([]);
  const log = lines.join("\n");
  for (const bit of [VISITOR.name, VISITOR.email, VISITOR.note, "orla.vantage", "Cleanup note"]) expect(log, `the log holds "${bit}"`).not.toContain(bit);
});

/** A host with one link that offers START. */
async function hostWithLink(link: { meet?: boolean } = {}) {
  const { host, id } = await google.hostWithLink({ title: "Cleanup call", ...link }, { name: "Cem Host" });
  expect(await app.startsOf(id)).toContain(START);
  return { host, id };
}

/** Each DELETE sent: its call, and its calendar and event as written in the path. */
function deletes() {
  return fake.of("delete").map((call) => {
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(call.url.pathname);
    expect(m, call.url.pathname).not.toBeNull();
    return { call, calendarId: m![1], eventId: m![2] };
  });
}

/** Expect exactly one DELETE, of `eventId` on the primary calendar, with sendUpdates=all and the host's token, sent after the insert. */
function expectOneCleanup(host: GoogleHost, eventId: string) {
  const ds = deletes();
  expect(ds).toHaveLength(1);
  const [d] = ds;
  expect(d.call.url.pathname).toBe(`/calendar/v3/calendars/primary/events/${eventId}`);
  expect([...d.call.url.searchParams]).toEqual([["sendUpdates", "all"]]);
  expect(d.call.account, "with the host's token").toBe(host.account);
  expect(fake.calls.indexOf(d.call)).toBeGreaterThan(fake.calls.indexOf(fake.of("insert")[0]));
}

/** The warn (or error) lines written from `mark` on, parsed. */
function warnsSince(mark: number): { level: string; text: string }[] {
  return lines
    .slice(mark)
    .map((text) => {
      try {
        return { level: String((JSON.parse(text) as { level?: unknown }).level), text };
      } catch {
        return { level: "unknown", text };
      }
    })
    .filter((l) => l.level !== "info");
}

describe("a booking deleted or cancelled while its insert is under way (criterion 2)", () => {
  const ways: [string, (b: { host: GoogleHost; bookingId: string }) => unknown][] = [
    [
      "cancelled",
      ({ bookingId }) => db.db().prepare("UPDATE bookings SET cancelled_at = ? WHERE id = ?").run(Date.now(), bookingId),
    ],
    ["deleted", ({ bookingId }) => db.db().prepare("DELETE FROM bookings WHERE id = ?").run(bookingId)],
    [
      "deleted with its host, who pressed Remove me",
      async ({ host }) => {
        app.signIn(host.id);
        const res = await meRoute.DELETE();
        app.signOut();
        expect(res.status).toBe(200);
        expect(db.getUser(host.id)).toBeFalsy();
      },
    ],
  ];

  it.each(ways)("%s: once the insert answers, one DELETE ...?sendUpdates=all of the event just made, no booking holds it, and the visitor gets 503", async (_how, goAway) => {
    const { host, id } = await hostWithLink();
    const making = gate();
    fake.answer.insert = async () => {
      await making.opened;
      return undefined;
    };
    const booking = app.book(id, { start: START, ...VISITOR });
    try {
      await waitFor(() => fake.of("insert").length === 1, "the insert");
      const [held] = app.bookingRows();
      expect(held.event_id).toBeNull();
      setNow(NOW + 1000);
      await goAway({ host, bookingId: String(held.id) });
    } finally {
      making.open();
    }
    const a = await booking;
    expect([a.status, a.json]).toEqual([503, CANT_BOOK]);
    // The event Google made...
    expect(fake.made).toHaveLength(1);
    const [madeId] = fake.made;
    // ...is deleted again, and Google no longer has it.
    expectOneCleanup(host, madeId);
    expect(fake.events.get(host.calendarId)!.map((e) => e.id)).not.toContain(madeId);
    // No booking holds it.
    expect(app.bookingRows().filter((r) => r.event_id === madeId)).toEqual([]);
    expect(app.everything()).not.toContain(madeId);
  });

  it("cancelled, with that DELETE failing: still 503, no booking holds the event, and one warn line with the host's and the event's ids", async () => {
    const { host, id } = await hostWithLink();
    const making = gate();
    fake.answer.insert = async () => {
      await making.opened;
      return undefined;
    };
    fake.answer.delete = failures.serverError;
    const booking = app.book(id, { start: START, ...VISITOR });
    try {
      await waitFor(() => fake.of("insert").length === 1, "the insert");
      db.db().prepare("UPDATE bookings SET cancelled_at = ? WHERE id = ?").run(Date.now(), String(app.bookingRows()[0].id));
    } finally {
      making.open();
    }
    const mark = lines.length;
    const a = await booking;
    expect([a.status, a.json]).toEqual([503, CANT_BOOK]);
    const [madeId] = fake.made;
    expectOneCleanup(host, madeId);
    expect(app.bookingRows().filter((r) => r.event_id === madeId)).toEqual([]);
    const withEvent = warnsSince(mark).filter((l) => l.text.includes(madeId));
    expect(withEvent).toHaveLength(1);
    expect(withEvent[0].level).toBe("warn");
    expect(withEvent[0].text).toContain(host.id);
  });
});

describe("the event's own id (criterion 3)", () => {
  it("is sent in the insert's body: the booking's id without its dashes, an id Google takes, and stored as the booking's event", async () => {
    const { host, id } = await hostWithLink({ meet: true });
    const a = await app.book(id, { start: START, ...VISITOR });
    expect(a.status, a.text).toBe(200);
    const [row] = app.bookingRows();
    const [insert] = fake.of("insert");
    const sent = insert.json!.id;
    expect(sent).toBe(String(row.id).replace(/-/g, ""));
    expect(String(sent)).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(row.event_id).toBe(sent);
    expect(fake.events.get(host.calendarId)!.map((e) => e.id)).toEqual([sent]);
    expect(fake.of("delete")).toEqual([]);
  });

  it("differs from one booking to the next", async () => {
    const { id } = await hostWithLink();
    expect((await app.book(id, { start: START, ...VISITOR })).status).toBe(200);
    expect((await app.book(id, { start: ist(19, 11), ...VISITOR })).status).toBe(200);
    const sent = fake.of("insert").map((c) => c.json!.id);
    expect(sent).toEqual(app.bookingRows().map((r) => String(r.id).replace(/-/g, "")));
    expect(new Set(sent).size).toBe(2);
  });
});

describe("an insert whose outcome is unknown (criterion 3)", () => {
  /** Google makes the event, as an insert does, and then fails to say so. */
  const afterMaking = (fail: Outcome) => (call: Call) => {
    expect(fake.usual(call).status).toBe(200);
    return fail;
  };
  const unknown: [string, (call: Call) => Outcome, boolean][] = [
    ["times out", () => "timeout", false],
    ["times out after Google made the event", (call) => afterMaking("timeout")(call), true],
    ["can't reach Google", () => "network", false],
    ["loses the connection after Google made the event", (call) => afterMaking("network")(call), true],
    ["answers 500", () => failures.serverError(), false],
    ["answers 500 after Google made the event", (call) => afterMaking(failures.serverError())(call), true],
    ["answers 502", () => new Response("<html><title>502 Bad Gateway</title></html>", { status: 502, headers: { "Content-Type": "text/html" } }), false],
    ["answers 503", () => apiError(503, "backendError"), false],
    ["answers 503 after Google made the event", (call) => afterMaking(apiError(503, "backendError"))(call), true],
  ];

  it.each(unknown)("an insert that %s: one DELETE of the id sent, on primary with sendUpdates=all, then 503, and no booking left", async (what, answer, made) => {
    if (what.includes("times out")) timeouts = shortTimeouts(30);
    const { host, id } = await hostWithLink({ meet: true });
    const bookingIds: string[] = [];
    fake.answer.insert = (call) => {
      bookingIds.push(String(app.bookingRows()[0]?.id));
      return answer(call);
    };
    const mark = lines.length;
    const a = await app.book(id, { start: START, ...VISITOR });
    expect([a.status, a.json]).toEqual([503, CANT_BOOK]);

    const [insert] = fake.of("insert");
    const sent = String(insert.json!.id);
    expect(sent).toBe(bookingIds[0].replace(/-/g, ""));
    expect(fake.made).toEqual(made ? [sent] : []);
    expectOneCleanup(host, sent);
    // Google has no event left, and nothing of the booking is kept.
    expect(fake.events.get(host.calendarId)).toEqual([]);
    expect(app.bookingRows()).toEqual([]);
    const stored = app.everything();
    for (const bit of [VISITOR.name, VISITOR.email, VISITOR.note]) expect(stored).not.toContain(bit);
    // The DELETE answered 204 or 404: no warn line of its own, only the insert's.
    expect(warnsSince(mark).map((l) => l.level)).toEqual(["warn"]);
    if (what.includes("times out")) expect(fake.of("delete").every((c) => c.signal !== null)).toBe(true);
    // The time is offered again.
    timeouts?.mockRestore();
    timeouts = null;
    expect(await app.startsOf(id)).toContain(START);
  });

  it("answers the visitor only once that DELETE has answered", async () => {
    const { host, id } = await hostWithLink();
    fake.answer.insert = failures.serverError;
    const deleting = gate();
    fake.answer.delete = async () => {
      await deleting.opened;
      return undefined;
    };
    let answered = false;
    const booking = app.book(id, { start: START, ...VISITOR }).then((a) => {
      answered = true;
      return a;
    });
    try {
      await waitFor(() => fake.of("delete").length === 1, "the DELETE");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(answered, "the 503 came before the DELETE answered").toBe(false);
    } finally {
      deleting.open();
    }
    const a = await booking;
    expect([a.status, a.json]).toEqual([503, CANT_BOOK]);
    expectOneCleanup(host, String(fake.of("insert")[0].json!.id));
  });

  // The inserts made. Changed in run 2026-11-21-ekip-booking-tokens: an insert
  // answered 401 is made once more with a new token, under the same id, and
  // failures.unauthorized answers that one 401 too.
  const refused: [string, () => Outcome, number][] = [
    ["400", () => apiError(400, "invalid"), 1],
    ["401", failures.unauthorized, 2],
    ["403, a missing permission", failures.forbidden, 1],
    ["403, a rate limit", failures.rateLimited, 1],
    ["403, forbidden", () => apiError(403, "forbidden"), 1],
    ["409", () => apiError(409, "duplicate"), 1],
  ];

  it.each(refused)("an insert answering %s sends no DELETE, answers 503 and keeps no booking", async (_what, answer, inserts) => {
    const { host, id } = await hostWithLink();
    fake.answer.insert = answer;
    const a = await app.book(id, { start: START, ...VISITOR });
    expect([a.status, a.json]).toEqual([503, CANT_BOOK]);
    expect(fake.of("insert")).toHaveLength(inserts);
    expect(new Set(fake.of("insert").map((c) => c.json?.id)).size, "one event id").toBe(1);
    expect(fake.of("delete")).toEqual([]);
    expect(app.bookingRows()).toEqual([]);
    expect(fake.events.get(host.calendarId)).toEqual([]);
  });
});

describe("the DELETE after an insert whose outcome is unknown (criterion 3)", () => {
  const quiet: [string, () => Outcome][] = [
    ["204", () => new Response(null, { status: 204 })],
    ["an empty 200", () => new Response("", { status: 200 })],
    ["404", () => apiError(404, "notFound")],
    ["410", () => apiError(410, "deleted")],
  ];
  const loud: [string, () => Outcome][] = [
    ["500", failures.serverError],
    ["503", () => apiError(503, "backendError")],
    ["400", () => apiError(400, "badRequest")],
    ["401", failures.unauthorized],
    ["403", () => apiError(403, "forbidden")],
    ["a timeout", () => "timeout"],
    ["no connection", () => "network"],
  ];

  /** The insert answers 500; the DELETE that follows answers `answer`. The warn lines written meanwhile, and the event id. */
  async function cleanupAnswering(answer: () => Outcome) {
    const { host, id } = await hostWithLink();
    fake.answer.insert = failures.serverError;
    fake.answer.delete = answer;
    const mark = lines.length;
    const a = await app.book(id, { start: START, ...VISITOR });
    expect([a.status, a.json]).toEqual([503, CANT_BOOK]);
    const sent = String(fake.of("insert")[0].json!.id);
    expectOneCleanup(host, sent);
    expect(app.bookingRows()).toEqual([]);
    return { host, sent, warns: warnsSince(mark) };
  }

  it.each(quiet)("answering %s writes no warn line of its own", async (_what, answer) => {
    const { warns } = await cleanupAnswering(answer);
    // Only the insert's own warn line.
    expect(warns.map((l) => l.level)).toEqual(["warn"]);
  });

  it.each(loud)("answering %s writes one warn line, with the host's id and the event's id, and nothing of the visitor", async (what, answer) => {
    if (what === "a timeout") timeouts = shortTimeouts(30);
    const { host, sent, warns } = await cleanupAnswering(answer);
    // The insert's own warn line, and the DELETE's.
    expect(warns.map((l) => l.level)).toEqual(["warn", "warn"]);
    const withEvent = warns.filter((l) => l.text.includes(sent));
    expect(withEvent).toHaveLength(1);
    expect(withEvent[0].text).toContain(host.id);
    for (const bit of [VISITOR.name, VISITOR.email, VISITOR.note]) expect(withEvent[0].text).not.toContain(bit);
  });
});
