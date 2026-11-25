import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, random } from "./booking-reference";
import { bookingApp, type Answer, type LinkBody } from "./booking-helpers";

// Booking links' quick wins (run 2026-11-25-ekip-quick-wins-visitor),
// criterion 7, the server's side:
// - A try refused by the limit per address (5 tries in any 10 minutes,
//   whatever they answer, the refused ones included) says how long to wait,
//   in whole minutes rounded up, never shorter than the real wait: "Too many
//   tries. Try again in 7 minutes." The answer carries Retry-After, in
//   seconds.
// - A link that took its 30 bookings in the last hour answers with its own
//   message, which doesn't speak of the visitor's tries.
// - What counts toward either limit doesn't change.
// The real wait comes from a model of the limit written here, which counts
// every try at the moment it's made. In the demo; nothing reaches the network.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "t".repeat(40);
process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 30\n";
process.env.BOOKING_LINKS = "on";
process.env.DEMO_MODE = "true";
process.env.APP_URL = "https://cal.example.com";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const app = await bookingApp(jar);

const ist = (d: number, h: number, m = 0) => at("Europe/Istanbul", 2026, 11, d, h, m);
const NOW = ist(18, 9);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const WINDOW = 10 * MIN;

const setNow = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};
let guests = 0;
const valid = (start: number) => ({ start, name: "Limit Guest", email: `limit${++guests}@guests.example.org` });
/** Refused before anything is booked, so it books nothing and can be sent any number of times. */
const invalid = { start: ist(19, 10), name: "", email: "nobody@guests.example.org" };
const from = (address: string) => ({ "cf-connecting-ip": address });

/** "Too many tries. Try again in 7 minutes.", for a wait of `ms`: whole minutes, rounded up. */
const tooMany = (ms: number) => {
  const n = Math.ceil(ms / MIN);
  return `Too many tries. Try again in ${n} ${n === 1 ? "minute" : "minutes"}.`;
};

/** The limit per address, as the criteria state it: a try goes ahead when fewer than 5 tries came in the 10 minutes before it. */
class Model {
  private tries: number[] = [];
  /** Make a try at `t`; whether it goes ahead. It counts either way. */
  attempt(t: number): boolean {
    const before = this.tries.filter((s) => s > t - WINDOW).length;
    this.tries.push(t);
    return before < 5;
  }
  /** After a try at `t`: how long until the next one goes ahead, if none is made meanwhile. */
  wait(t: number): number {
    const latest = [...this.tries].sort((a, b) => b - a);
    // The next try goes ahead once the 5th most recent try is 10 minutes old.
    return latest.length < 5 ? 0 : Math.max(0, latest[4] + WINDOW - t);
  }
}

beforeEach(() => {
  app.db.resetAll();
  app.signOut();
  setNow(NOW);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.booking-limits")];
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("test: no network");
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const retryAfter = (a: Answer) => a.headers.get("retry-after");

describe("a try the limit per address refused", () => {
  it("says the wait in whole minutes, rounded up, and Retry-After in seconds: five tries, then one 5.5 minutes later", async () => {
    const { id } = await app.hostWithLink();
    const A = "203.0.113.10";
    for (let i = 0; i < 5; i++) expect((await app.book(id, invalid, from(A))).status).toBe(400);
    setNow(NOW + 5.5 * MIN);
    const a = await app.book(id, invalid, from(A));
    // The five are 10 minutes old at NOW + 10 min: 4.5 minutes from now.
    expect([a.status, a.json]).toEqual([429, { error: "Too many tries. Try again in 5 minutes." }]);
    expect(retryAfter(a)).toBe("270");
    // Waiting what it said is enough; a moment less isn't (and counts again).
    setNow(NOW + 10 * MIN);
    expect((await app.book(id, invalid, from(A))).status).toBe(400);
  });

  it("isn't shorter than the real wait one second before it's over", async () => {
    const { id } = await app.hostWithLink();
    const A = "203.0.113.11";
    for (let i = 0; i < 5; i++) await app.book(id, invalid, from(A));
    setNow(NOW + 10 * MIN - SEC);
    const a = await app.book(id, invalid, from(A));
    expect([a.status, a.json]).toEqual([429, { error: "Too many tries. Try again in 1 minute." }]);
    expect(retryAfter(a)).toBe("1");
    setNow(NOW + 10 * MIN);
    expect((await app.book(id, invalid, from(A))).status).toBe(400);
  });

  it("counts the refused try itself: a try a moment early waits again, for as long as the 5th latest try needs", async () => {
    const { id } = await app.hostWithLink();
    const A = "203.0.113.12";
    // Tries at +0, +1, +2, +3 and +4 minutes; the 6th at +5 is refused.
    for (let i = 0; i < 5; i++) {
      setNow(NOW + i * MIN);
      expect((await app.book(id, invalid, from(A))).status).toBe(400);
    }
    setNow(NOW + 5 * MIN);
    const sixth = await app.book(id, invalid, from(A));
    // Counting this one, the 5th latest try is +1's, which leaves the 10 minutes at +11: 6 minutes, not 5.
    expect([sixth.status, sixth.json, retryAfter(sixth)]).toEqual([429, { error: "Too many tries. Try again in 6 minutes." }, "360"]);
    // At +10 the tries in the 10 minutes before it are +1, +2, +3, +4 and +5 (the refused one).
    setNow(NOW + 10 * MIN);
    const seventh = await app.book(id, invalid, from(A));
    // Counting it, the 5th latest is +2: 2 minutes, not 1 (from +1) and not the full 10.
    expect([seventh.status, seventh.json, retryAfter(seventh)]).toEqual([429, { error: tooMany(2 * MIN) }, "120"]);
    setNow(NOW + 12 * MIN - 1);
    expect((await app.book(id, invalid, from(A))).status).toBe(429);
  });

  it("agrees with the model on random runs of tries from a few addresses, never telling a shorter wait", async () => {
    const { id } = await app.hostWithLink();
    const next = random(7);
    let refused = 0;
    let t = NOW;
    const models = new Map<string, Model>();
    for (let n = 0; n < 400; n++) {
      // Mostly gaps under 40 seconds, now and then a pause of up to 6 minutes, at odd milliseconds.
      t += (next() < 0.8 ? Math.floor(next() * 40 * SEC) : Math.floor(next() * 6 * MIN)) + (next() < 0.3 ? Math.floor(next() * 999) : 0);
      setNow(t);
      const address = `198.51.100.${1 + Math.floor(next() * 2)}`;
      const model = models.get(address) ?? new Model();
      models.set(address, model);
      const goes = model.attempt(t);
      const a = await app.book(id, invalid, from(address));
      const label = `try ${n} from ${address} at +${t - NOW} ms`;
      if (goes) {
        expect(a.status, label).toBe(400);
        expect(retryAfter(a), label).toBeNull();
        continue;
      }
      refused++;
      const wait = model.wait(t);
      expect([a.status, a.json], label).toEqual([429, { error: tooMany(wait) }]);
      const seconds = Number(retryAfter(a));
      expect(Number.isInteger(seconds), label).toBe(true);
      // Rounded up to whole seconds and minutes: never shorter, and less than a unit longer.
      expect(seconds * SEC, label).toBeGreaterThanOrEqual(wait);
      expect(seconds * SEC - wait, label).toBeLessThan(SEC);
      const minutes = Number(/in (\d+) minutes?\./.exec((a.json as { error: string }).error)![1]);
      expect(minutes * MIN, label).toBeGreaterThanOrEqual(wait);
      expect(minutes * MIN - wait, label).toBeLessThan(MIN);
    }
    expect(refused).toBeGreaterThan(50);
    expect(400 - refused).toBeGreaterThan(50);
  });
});

describe("a link that took its 30 bookings in the last hour", () => {
  const WIDE: Partial<LinkBody> = { durationMin: 15, startMin: 0, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], aheadDays: 3 };

  it("answers with its own message, the same each time, which doesn't speak of the visitor's tries", async () => {
    const { id } = await app.hostWithLink(WIDE);
    const times = await app.startsOf(id);
    for (const start of times.slice(40, 70)) expect((await app.book(id, valid(start))).status).toBe(200);
    const answers: Answer[] = [];
    for (let i = 0; i < 3; i++) answers.push(await app.book(id, valid(times[100 + i])));
    for (const a of answers) {
      expect(a.status).toBe(429);
      expect(a.json).toEqual(answers[0].json);
    }
    const message = (answers[0].json as { error: string }).error;
    expect(message).not.toMatch(/tries|too many/i);
    expect(message).not.toMatch(/^Too many tries/);
    expect(message.length).toBeGreaterThan(0);
    // It's the message the troubleshooting table lists for it.
    const table = readFileSync(new URL("../docs/troubleshooting.md", import.meta.url), "utf8");
    expect(table).toContain(`| ${message} |`);
    // Still the link's limit an hour later: then it books again.
    setNow(NOW + HOUR + SEC);
    expect((await app.book(id, valid(times[120]))).status).toBe(200);
  });

  it("isn't the visitor's own limit: their next tries elsewhere still go ahead", async () => {
    const full = await app.hostWithLink(WIDE);
    const other = await app.hostWithLink(WIDE);
    const times = await app.startsOf(full.id);
    for (const start of times.slice(40, 70)) await app.book(full.id, valid(start));
    const A = "203.0.113.20";
    const refused = await app.book(full.id, valid(times[100]), from(A));
    expect(refused.status).toBe(429);
    expect(refused.json).not.toEqual({ error: expect.stringMatching(/^Too many tries/) });
    // That refusal is one of A's five tries, as before (team question 9).
    for (let i = 0; i < 4; i++) expect((await app.book(other.id, invalid, from(A))).status, String(i)).toBe(400);
    const sixth = await app.book(other.id, invalid, from(A));
    expect(sixth.status).toBe(429);
    expect((sixth.json as { error: string }).error).toMatch(/^Too many tries\. Try again in \d+ minutes?\.$/);
  });
});
