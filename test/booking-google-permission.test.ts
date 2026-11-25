import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { at } from "./booking-reference";
import { CANT_BOOK, bookingApp } from "./booking-helpers";
import { CANT_CANCEL, googleSide, withGoogle, type GoogleHost } from "./booking-google-helpers";
import { apiError, failures, fakeGoogle, jsonResponse } from "./google-fake";
import { captureConsole } from "./link-helpers";

// Booking links, part 2b (run 2026-11-19-ekip-booking-2b), criterion 4: a 403
// from the insert (POST /api/book/[id]) or from a cancel's DELETE (POST
// /api/book/cancel/[token], POST /api/me/bookings/[id]/cancel) clears the
// host's booking_access only when Google's reason is insufficientPermissions
// or ACCESS_TOKEN_SCOPE_INSUFFICIENT, in errors[].reason or details[].reason.
// Any other 403 leaves it. Either way the booking answers 503, and the cancel
// answers 503 with the booking kept. The warn line for a missing permission
// doesn't send the host to "See your calendars". Google is a stubbed fetch.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "p".repeat(40);
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
const VISITOR = { name: "Pia Margrave", email: "pia.margrave@guests.example.org", note: "Permission note 8841" };

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

/** A 403 with Google's error body: `errors` and `details` as given. */
const forbiddenWith = (body: { errors?: { reason: string }[]; details?: { reason: string }[]; status?: string }) => () =>
  jsonResponse(403, { error: { code: 403, message: "Test refusal", ...body } });

/** A 403 for a missing permission, wherever Google names it. */
const MISSING: [string, () => Response][] = [
  ["insufficientPermissions in errors[].reason", forbiddenWith({ errors: [{ reason: "insufficientPermissions" }] })],
  ["ACCESS_TOKEN_SCOPE_INSUFFICIENT in errors[].reason", forbiddenWith({ errors: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] })],
  ["insufficientPermissions in details[].reason", forbiddenWith({ status: "PERMISSION_DENIED", details: [{ reason: "insufficientPermissions" }] })],
  ["ACCESS_TOKEN_SCOPE_INSUFFICIENT in details[].reason", forbiddenWith({ status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] })],
  ["both, as Google sends them", failures.forbidden],
];

/** Any other 403. */
const OTHER: [string, () => Response][] = [
  ["rateLimitExceeded", () => apiError(403, "rateLimitExceeded")],
  ["userRateLimitExceeded", () => apiError(403, "userRateLimitExceeded")],
  ["quotaExceeded", () => apiError(403, "quotaExceeded")],
  ["forbidden", () => apiError(403, "forbidden", { status: "PERMISSION_DENIED" })],
  ["forbidden in details[].reason", forbiddenWith({ status: "PERMISSION_DENIED", details: [{ reason: "forbidden" }] })],
  ["no body", () => new Response(null, { status: 403 })],
  ["an HTML page", () => new Response("<html><title>403 Forbidden</title></html>", { status: 403, headers: { "Content-Type": "text/html" } })],
];

/** Each 403, with the booking_access it leaves: 0 for a missing permission, 1 (unchanged) for any other. */
const CASES: [string, 0 | 1, () => Response][] = [
  ...MISSING.map(([what, answer]): [string, 0 | 1, () => Response] => [what, 0, answer]),
  ...OTHER.map(([what, answer]): [string, 0 | 1, () => Response] => [what, 1, answer]),
];

const accessOf = (host: { id: string }) => db.getUser(host.id)!.booking_access;

describe("a 403 on the insert (criterion 4)", () => {
  it.each(CASES)("with %s: 503, no booking kept, and booking_access %s", async (_what, access, answer) => {
    const { host, id } = await google.hostWithLink({ title: "Access call" }, { name: "Ece Host" });
    expect(accessOf(host)).toBe(1);
    fake.answer.insert = answer;
    const mark = lines.length;
    const a = await app.book(id, { start: START, ...VISITOR });
    expect([a.status, a.json]).toEqual([503, CANT_BOOK]);
    expect(app.bookingRows()).toEqual([]);
    expect(accessOf(host)).toBe(access);
    // A 4xx made no event: nothing to delete.
    expect(fake.of("delete")).toEqual([]);
    expect(lines.slice(mark).join("\n")).not.toContain("See your calendars");
    expect(db.getUser(host.id)!.token_error).toBeNull();
  });
});

type Booked = { host: GoogleHost; token: string; bookingId: string; row: Record<string, unknown> };

/** A booking made outside the demo, with its event; 5 minutes later, with the calls so far forgotten. */
async function booked(): Promise<Booked> {
  const { host, id } = await google.hostWithLink({ title: "Access call" }, { name: "Ece Host" });
  const { token, row } = await google.bookIt(id, START, VISITOR);
  expect(row.event_id).toEqual(expect.any(String));
  fake.calls.length = 0;
  setNow(NOW + 5 * MIN);
  return { host, token, bookingId: String(row.id), row };
}

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

describe("a 403 on a cancel's DELETE (criterion 4)", () => {
  const cases = ROUTE_NAMES.flatMap((route) => CASES.map(([what, access, answer]) => [route, what, access, answer] as const));

  it.each(cases)("by %s, with %s: 503, the booking kept, and booking_access %s", async (route, _what, access, answer) => {
    const b = await booked();
    expect(accessOf(b.host)).toBe(1);
    fake.answer.delete = answer;
    const mark = lines.length;
    const a = await ROUTES[route](b);
    expect([a.status, a.json]).toEqual([503, CANT_CANCEL]);
    expect(fake.of("delete")).toHaveLength(1);
    // The booking is kept as it was, and so is its event.
    expect(app.bookingRows().find((r) => r.id === b.bookingId)).toEqual(b.row);
    expect(fake.events.get(b.host.calendarId)!.map((e) => e.id)).toContain(b.row.event_id);
    expect(accessOf(b.host)).toBe(access);
    expect(lines.slice(mark).join("\n")).not.toContain("See your calendars");
  });
});
