import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at } from "./booking-reference";
import { CANT_BOOK, LINK, LINK_FULL, NOT_FOUND, TOO_MANY, bookingApp, type Answer, type LinkBody, type Made } from "./booking-helpers";

// Booking links: the rate limits on POST /api/book/[id] (run
// 2026-11-19-ekip-booking-1b, criterion 1).
// - From one client address, at most 5 tries per 10 minutes, whatever they
//   answer and whichever ids they're for. The address is cf-connecting-ip,
//   else the last X-Forwarded-For entry, else "unknown".
// - On one link, at most 30 bookings made within the last hour, from anyone,
//   cancelled ones included. Past that, a request with a valid body answers
//   429 with the same message, and nothing is stored. Tries that book nothing
//   don't count toward the link.
// Since run 2026-11-25-ekip-quick-wins-visitor (criterion 7) the two answer
// apart: the limit per address says how many minutes to wait (TOO_MANY), and
// a full link has its own message (LINK_FULL). What counts is unchanged.
// In the demo unless a test says otherwise, so an allowed try for a free time
// books it.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "r".repeat(40);
process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 30\n";
process.env.BOOKING_LINKS = "on";
process.env.DEMO_MODE = "true";
process.env.APP_URL = "https://cal.example.com";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const app = await bookingApp(jar);

const ist = (d: number, h: number, m = 0) => at("Europe/Istanbul", 2026, 11, d, h, m);
/** Wednesday 2026-11-18, 09:00 in Istanbul. */
const NOW = ist(18, 9);
const MIN = 60_000;
const SEC = 1000;
const HOUR = 60 * MIN;
const LIMITS = Symbol.for("ekip-takvim.booking-limits");

const setNow = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};
/** Forget the in-memory limiter state, as the criterion names it. */
const forgetLimiter = () => {
  delete (globalThis as Record<symbol, unknown>)[LIMITS];
};

let guests = 0;
/** A body that books `start`. */
const valid = (start: number) => ({ start, name: "Rate Guest", email: `rate${++guests}@guests.example.org` });
/** A body that's refused before anything is booked. */
const invalid = { start: ist(19, 10), name: "", email: "nobody@guests.example.org" };
const from = (address: string) => ({ "cf-connecting-ip": address });
const forwarded = (list: string) => ({ "x-forwarded-for": list });
const answer = (a: Answer) => [a.status, a.json];

/** A host with a link offering Wednesday to Friday, 10:00 to 12:00 (12 times); its id and those times. */
async function link() {
  const { id } = await app.hostWithLink({ aheadDays: 3 });
  return { id, times: await app.startsOf(id) };
}

/** Every 15 minutes, all day, from now to the end of Friday: about 250 times. */
const WIDE: Partial<LinkBody> = { durationMin: 15, startMin: 0, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], aheadDays: 3 };

/** A host with one wide link; the link's id, the host and the times it offers now. */
async function wideLink() {
  const { id, host } = await app.hostWithLink(WIDE);
  const times = await app.startsOf(id);
  expect(times.length).toBeGreaterThan(200);
  return { id, host, times };
}

/** `n` of `times` from the `skip`th on: Wednesday evening or later, so still offered hours from now. */
function later(times: number[], n: number, skip = 40): number[] {
  const out = times.slice(skip, skip + n);
  expect(out).toHaveLength(n);
  return out;
}

/** Book each of `starts` on link `id`, each from an address of its own; the cancel tokens. */
async function bookMany(id: string, starts: number[]): Promise<string[]> {
  const tokens: string[] = [];
  for (const start of starts) {
    const a = await app.book(id, valid(start));
    expect(a.status, `booking ${tokens.length + 1} at ${new Date(start).toISOString()}: ${a.text}`).toBe(200);
    tokens.push(new URL((a.json as Made).cancelUrl).pathname.split("/").pop()!);
  }
  return tokens;
}

const rowsOf = (id: string) => app.bookingRows().filter((r) => r.link_id === id);
const tally = (statuses: number[]) => statuses.reduce<Record<number, number>>((t, s) => ({ ...t, [s]: (t[s] ?? 0) + 1 }), {});

beforeEach(() => {
  app.db.resetAll();
  app.signOut();
  setNow(NOW);
  forgetLimiter();
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("test: no network");
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
  process.env.DEMO_MODE = "true";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

describe("from one client address", () => {
  it("answers the 6th try within 10 minutes with 429, whatever the first five answered", async () => {
    const a = await link();
    const b = await link();
    const c = await link();
    const A = "203.0.113.7";
    expect((await app.book(a.id, invalid, from(A))).status).toBe(400);
    expect((await app.book("doesNotExist", valid(a.times[0]), from(A))).status).toBe(404);
    expect((await app.book(a.id, valid(a.times[0]), from(A))).status).toBe(200);
    expect((await app.book(a.id, valid(a.times[0]), from(A))).status).toBe(409);
    expect((await app.book(b.id, { ...valid(b.times[0]), email: "no-at-sign" }, from(A))).status).toBe(400);
    const stored = app.bookingRows().length;

    setNow(NOW + 10 * MIN - SEC);
    const sixth = await app.book(c.id, valid(c.times[0]), from(A));
    expect([sixth.status, sixth.json]).toEqual([429, TOO_MANY]);
    expect(app.bookingRows()).toHaveLength(stored);
    // Another address isn't held back.
    expect((await app.book(c.id, valid(c.times[0]), from("203.0.113.8"))).status).toBe(200);
    // Ten minutes after the five, the address may try again.
    setNow(NOW + 10 * MIN + SEC);
    expect((await app.book(c.id, valid(c.times[1]), from(A))).status).toBe(200);
  });

  it("allows five tries within 10 minutes", async () => {
    const a = await link();
    const A = "203.0.113.9";
    for (let i = 0; i < 5; i++) {
      setNow(NOW + i * MIN);
      expect((await app.book(a.id, valid(a.times[i]), from(A))).status, String(i)).toBe(200);
    }
    expect(app.bookingRows()).toHaveLength(5);
  });

  it("takes cf-connecting-ip as the address, whatever X-Forwarded-For says", async () => {
    const a = await link();
    for (let i = 0; i < 5; i++) {
      expect((await app.book(a.id, invalid, { ...from("198.51.100.1"), ...forwarded(`192.0.2.${i}`) })).status).toBe(400);
    }
    const sixth = await app.book(a.id, valid(a.times[0]), { ...from("198.51.100.1"), ...forwarded("192.0.2.99") });
    expect(sixth.status).toBe(429);
    // The same X-Forwarded-For with other cf-connecting-ip values: other addresses.
    const b = await link();
    for (let i = 0; i < 6; i++) {
      const tried = await app.book(b.id, valid(b.times[i]), { ...from(`198.51.100.${20 + i}`), ...forwarded("192.0.2.50, 198.51.100.4") });
      expect(tried.status, String(i)).toBe(200);
    }
  });

  it("takes the last X-Forwarded-For entry when there's no cf-connecting-ip", async () => {
    const a = await link();
    for (let i = 0; i < 5; i++) expect((await app.book(a.id, invalid, forwarded(`192.0.2.${i}, 198.51.100.2`))).status).toBe(400);
    expect((await app.book(a.id, valid(a.times[0]), forwarded("192.0.2.77, 198.51.100.2"))).status).toBe(429);
    expect((await app.book(a.id, valid(a.times[0]), forwarded("198.51.100.2"))).status).toBe(429);
    // The same first entry, other last ones: other addresses.
    const b = await link();
    for (let i = 0; i < 6; i++) {
      expect((await app.book(b.id, valid(b.times[i]), forwarded(`198.51.100.3, 10.9.0.${i}`))).status, String(i)).toBe(200);
    }
  });

  it("counts tries with neither header under one address, unknown", async () => {
    const a = await link();
    for (let i = 0; i < 5; i++) expect((await app.book(a.id, invalid, {})).status).toBe(400);
    expect((await app.book(a.id, valid(a.times[0]), {})).status).toBe(429);
    expect((await app.book(a.id, valid(a.times[0]), from("198.51.100.200"))).status).toBe(200);
  });

  it("from one address: a try its own limit refused counts toward the next ten minutes", async () => {
    const a = await link();
    const A = "203.0.113.70";
    for (let i = 0; i < 5; i++) await app.book(a.id, invalid, from(A));
    setNow(NOW + 5 * MIN);
    expect((await app.book(a.id, invalid, from(A))).status).toBe(429);
    // The first five are over ten minutes old; the refused try isn't.
    setNow(NOW + 10 * MIN + SEC);
    for (let i = 0; i < 4; i++) expect((await app.book(a.id, invalid, from(A))).status, String(i)).toBe(400);
    const sixthInTen = await app.book(a.id, valid(a.times[0]), from(A));
    expect([sixthInTen.status, sixthInTen.json]).toEqual([429, TOO_MANY]);
  });

  // An address that keeps trying while refused stays refused: each refused try
  // is one of the requests in the next try's ten minutes. It gets through once
  // fewer than five are left in them, counted from the 5th-last try.
  it("from one address: a long run of refused tries stays refused until fewer than five are in the last 10 minutes", async () => {
    const early = await link();
    const late = await link();
    const tries = [
      { id: early.id, address: "203.0.113.80" },
      { id: late.id, address: "203.0.113.81" },
    ];
    // Each address tries every minute from +0 to +20 min: the first five are
    // 400, every one after is the 6th (or later) within ten minutes.
    for (let k = 0; k <= 20; k++) {
      setNow(NOW + k * MIN);
      for (const { id, address } of tries) {
        expect((await app.book(id, invalid, from(address))).status, `${address} at +${k} min`).toBe(k < 5 ? 400 : 429);
      }
    }
    // Their last five tries came at +16 to +20 min. At +26 min - 1 s all five
    // are within ten minutes, so this try is the 6th.
    setNow(NOW + 26 * MIN - SEC);
    const sixth = await app.book(early.id, valid(early.times[0]), from(tries[0].address));
    expect([sixth.status, sixth.json]).toEqual([429, TOO_MANY]);
    // At +26 min + 1 s only four are (+17 to +20), so this try is the 5th.
    setNow(NOW + 26 * MIN + SEC);
    expect((await app.book(late.id, valid(late.times[0]), from(tries[1].address))).status).toBe(200);
  });

  // "Whatever the first five answered" includes the 429 a full link gives.
  it("counts the tries a full link refused: after five of them, a 6th elsewhere is 429", async () => {
    const full = await wideLink();
    const elsewhere = await wideLink();
    await bookMany(full.id, later(full.times, 30));
    const A = "203.0.113.50";
    for (let i = 0; i < 5; i++) {
      expect(answer(await app.book(full.id, valid(full.times[100 + i]), from(A))), String(i)).toEqual([429, LINK_FULL]);
    }
    expect(answer(await app.book(elsewhere.id, valid(elsewhere.times[100]), from(A)))).toEqual([429, TOO_MANY]);
    expect(rowsOf(elsewhere.id)).toHaveLength(0);
    // Another address books there.
    expect((await app.book(elsewhere.id, valid(elsewhere.times[100]), from("203.0.113.51"))).status).toBe(200);
  });

  // The order of the answers: booking off is 404 before the limit, and isn't counted.
  it("doesn't count tries made while booking is off", async () => {
    const a = await wideLink();
    const A = "203.0.113.40";
    for (const setting of [undefined, "off", "maybe"]) {
      if (setting === undefined) delete process.env.BOOKING_LINKS;
      else process.env.BOOKING_LINKS = setting;
      for (let i = 0; i < 4; i++) {
        expect(answer(await app.book(a.id, valid(a.times[40 + i]), from(A))), `${setting}, ${i}`).toEqual([404, NOT_FOUND]);
      }
    }
    process.env.BOOKING_LINKS = "on";
    for (let i = 0; i < 5; i++) expect((await app.book(a.id, valid(a.times[40 + i]), from(A))).status, String(i)).toBe(200);
    expect(answer(await app.book(a.id, valid(a.times[45]), from(A)))).toEqual([429, TOO_MANY]);
  });
});

describe("on one link: at most 30 bookings made within the hour", () => {
  it("answers a valid body 429 from any address once 30 were made, stores nothing, and still answers a bad body 400", async () => {
    const a = await wideLink();
    const other = await wideLink();
    const booked = later(a.times, 30);
    await bookMany(a.id, booked);
    const rows = app.bookingRows();
    expect(rows).toHaveLength(30);

    // A free time, from cf-connecting-ip, X-Forwarded-For, neither, and a fresh address.
    const late = (i: number, start = a.times[100 + i]) => ({ start, name: "Late Guest", email: `late-${i}@guests.example.org`, note: `late note ${i}` });
    const headers: (Record<string, string> | undefined)[] = [from("198.18.1.1"), forwarded("192.0.2.1, 198.18.1.2"), {}, undefined];
    for (const [i, h] of headers.entries()) {
      expect(answer(await app.book(a.id, late(i), h)), `address ${i}`).toEqual([429, LINK_FULL]);
    }
    // A time it doesn't offer (taken, past, off the grid) is 429 too, not 409.
    expect(answer(await app.book(a.id, late(4, booked[0])))).toEqual([429, LINK_FULL]);
    expect(answer(await app.book(a.id, late(5, NOW - HOUR)))).toEqual([429, LINK_FULL]);
    expect(answer(await app.book(a.id, late(6, a.times[100] + 7 * MIN)))).toEqual([429, LINK_FULL]);
    expect(app.bookingRows()).toEqual(rows);
    const stored = app.everything();
    for (let i = 0; i <= 6; i++) {
      expect(stored).not.toContain(`late-${i}@guests.example.org`);
      expect(stored).not.toContain(`late note ${i}`);
    }

    // A body it can't read is still 400.
    for (const body of [invalid, { ...valid(a.times[100]), email: "no-at-sign" }, { start: "soon", name: "X", email: "x@guests.example.org" }, "{"]) {
      const bad = await app.book(a.id, body);
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(bad.json).toEqual({ error: expect.any(String) });
      expect(bad.json).not.toEqual(LINK_FULL);
    }
    expect(app.bookingRows()).toEqual(rows);
    // Another link isn't held back.
    expect((await app.book(other.id, valid(other.times[100]))).status).toBe(200);
  });

  it("takes a booking again once the oldest of its 30 is more than an hour old, and only one for each that leaves the hour", async () => {
    const a = await wideLink();
    const starts = later(a.times, 34);
    // One booking a minute, from +0 to +29 min.
    for (let i = 0; i < 30; i++) {
      setNow(NOW + i * MIN);
      await bookMany(a.id, [starts[i]]);
    }
    // The oldest is 1 ms short of an hour old: all 30 are within the hour.
    setNow(NOW + HOUR - 1);
    expect(answer(await app.book(a.id, valid(starts[30])))).toEqual([429, LINK_FULL]);
    // More than an hour old: 29 left in the hour, so one more books.
    setNow(NOW + HOUR + 1);
    expect((await app.book(a.id, valid(starts[30]))).status).toBe(200);
    expect(answer(await app.book(a.id, valid(starts[31])))).toEqual([429, LINK_FULL]);
    // The next oldest was made at +1 min.
    setNow(NOW + HOUR + MIN - 1);
    expect(answer(await app.book(a.id, valid(starts[31])))).toEqual([429, LINK_FULL]);
    setNow(NOW + HOUR + MIN + 1);
    expect((await app.book(a.id, valid(starts[31]))).status).toBe(200);
    expect(answer(await app.book(a.id, valid(starts[32])))).toEqual([429, LINK_FULL]);
    expect(rowsOf(a.id)).toHaveLength(32);
  });

  it("counts cancelled bookings, cancelled with the cancel link or by the host", async () => {
    const a = await wideLink();
    const starts = later(a.times, 30);
    const tokens = await bookMany(a.id, starts);
    // Ten with their cancel links, five by the host.
    for (const token of tokens.slice(0, 10)) expect((await app.cancel(token)).status).toBe(200);
    app.signIn(a.host.id);
    const byHost = app
      .bookingRows()
      .filter((r) => r.cancelled_at === null)
      .slice(0, 5)
      .map((r) => String(r.id));
    for (const id of byHost) expect((await app.cancelMine(id)).status, id).toBe(200);
    app.signOut();
    expect(app.bookingRows().filter((r) => r.cancelled_at !== null)).toHaveLength(15);
    // The link took 30 bookings this hour, so (part 2, criterion 3) it offers no
    // times, not even the cancelled ones', and a POST is still 429.
    expect(await app.startsOf(a.id)).toEqual([]);
    expect(answer(await app.book(a.id, valid(starts[0])))).toEqual([429, LINK_FULL]);
    expect(answer(await app.book(a.id, valid(a.times[100])))).toEqual([429, LINK_FULL]);
    // All 30 cancelled: still full.
    for (const token of tokens.slice(10)) await app.cancel(token);
    expect(app.bookingRows().every((r) => r.cancelled_at !== null)).toBe(true);
    expect(answer(await app.book(a.id, valid(starts[20])))).toEqual([429, LINK_FULL]);
    expect(app.bookingRows()).toHaveLength(30);
    // An hour after they were made, it offers their times again and books again.
    setNow(NOW + HOUR + 1);
    expect(await app.startsOf(a.id)).toEqual(expect.arrayContaining(starts));
    expect((await app.book(a.id, valid(starts[20]))).status).toBe(200);
  });

  it("doesn't count tries that book nothing: after 100 that answered 409, 400 or 404 from 100 addresses, it takes 30 bookings within the hour", async () => {
    const a = await wideLink();
    const statuses: number[] = [];
    const tryIt = async (id: string, body: unknown) => statuses.push((await app.book(id, body)).status);
    // 30 for times it doesn't offer: past, off the 15-minute grid, past its days.
    for (let i = 0; i < 10; i++) await tryIt(a.id, valid(NOW - (i + 1) * 15 * MIN));
    for (let i = 0; i < 10; i++) await tryIt(a.id, valid(a.times[40 + i] + 7 * MIN));
    for (let i = 0; i < 10; i++) await tryIt(a.id, valid(a.times.at(-1)! + (i + 1) * 24 * HOUR));
    // 30 with bodies it can't read.
    for (let i = 0; i < 30; i++) {
      await tryIt(a.id, [invalid, { ...valid(a.times[40]), email: "no-at-sign" }, { start: a.times[40], name: "No Email" }][i % 3]);
    }
    // 20 while the link is off.
    app.signIn(a.host.id);
    expect((await app.updateLink(a.id, { ...LINK, ...WIDE, active: false })).status).toBe(200);
    for (let i = 0; i < 20; i++) await tryIt(a.id, valid(a.times[40 + i]));
    expect((await app.updateLink(a.id, { ...LINK, ...WIDE, active: true })).status).toBe(200);
    app.signOut();
    // 10 while booking is off, 10 for ids no link has.
    process.env.BOOKING_LINKS = "off";
    for (let i = 0; i < 10; i++) await tryIt(a.id, valid(a.times[40 + i]));
    process.env.BOOKING_LINKS = "on";
    for (let i = 0; i < 10; i++) await tryIt(`madeUp${i}`, valid(a.times[40 + i]));
    expect(tally(statuses)).toEqual({ 400: 30, 404: 40, 409: 30 });
    expect(app.bookingRows()).toHaveLength(0);

    // Later in the same hour: 30 bookings, then 429.
    setNow(NOW + 30 * MIN);
    await bookMany(a.id, later(a.times, 30));
    expect(answer(await app.book(a.id, valid(a.times[100])))).toEqual([429, LINK_FULL]);
    expect(rowsOf(a.id)).toHaveLength(30);
  });

  it("doesn't count tries their address's limit refused", async () => {
    const a = await wideLink();
    const elsewhere = await wideLink();
    // 40 addresses use up their five tries elsewhere, then each tries this link.
    for (let k = 0; k < 40; k++) {
      const A = `203.0.114.${k}`;
      for (let i = 0; i < 5; i++) await app.book(elsewhere.id, invalid, from(A));
      expect(answer(await app.book(a.id, valid(a.times[40 + k]), from(A))), A).toEqual([429, TOO_MANY]);
    }
    expect(app.bookingRows()).toHaveLength(0);
    await bookMany(a.id, later(a.times, 30, 100));
    expect(answer(await app.book(a.id, valid(a.times[200])))).toEqual([429, LINK_FULL]);
  });

  it("doesn't count the tries a full link refused: an hour after its 30, it takes 30 more", async () => {
    const a = await wideLink();
    await bookMany(a.id, later(a.times, 30));
    setNow(NOW + 30 * MIN);
    for (let i = 0; i < 20; i++) expect(answer(await app.book(a.id, valid(a.times[100 + i]))), String(i)).toEqual([429, LINK_FULL]);
    setNow(NOW + HOUR + 1);
    await bookMany(a.id, later(a.times, 30, 100));
    expect(answer(await app.book(a.id, valid(a.times[200])))).toEqual([429, LINK_FULL]);
    expect(rowsOf(a.id)).toHaveLength(60);
  });

  it("stops requests sent together at 30: on a link with 25, 5 of 12 book and 7 are 429", async () => {
    const a = await wideLink();
    await bookMany(a.id, later(a.times, 25));
    const together = await Promise.all(later(a.times, 12, 100).map((start) => app.book(a.id, valid(start))));
    expect(tally(together.map((t) => t.status))).toEqual({ 200: 5, 429: 7 });
    for (const t of together.filter((t) => t.status === 429)) expect(t.json).toEqual(LINK_FULL);
    expect(rowsOf(a.id)).toHaveLength(30);
  });

  it("stops requests sent together at 30 on a link with none: 30 of 45 book", async () => {
    const a = await wideLink();
    const together = await Promise.all(later(a.times, 45).map((start) => app.book(a.id, valid(start))));
    expect(tally(together.map((t) => t.status))).toEqual({ 200: 30, 429: 15 });
    expect(rowsOf(a.id)).toHaveLength(30);
  });

  it("keeps its count when the in-memory limiter state is deleted", async () => {
    const a = await wideLink();
    await bookMany(a.id, later(a.times, 20));
    forgetLimiter();
    await bookMany(a.id, later(a.times, 10, 60));
    forgetLimiter();
    expect(answer(await app.book(a.id, valid(a.times[100])))).toEqual([429, LINK_FULL]);
    forgetLimiter();
    expect(answer(await app.book(a.id, valid(a.times[101])))).toEqual([429, LINK_FULL]);
    expect(rowsOf(a.id)).toHaveLength(30);
  });

  it("gives each of a host's two links its own 30", async () => {
    const host = app.person("Two Links Host");
    app.signIn(host.id);
    const first = await app.newLink(WIDE);
    const second = await app.newLink(WIDE);
    app.signOut();
    const firstTimes = await app.startsOf(first);
    await bookMany(first, later(firstTimes, 30));
    expect(answer(await app.book(first, valid(firstTimes[100])))).toEqual([429, LINK_FULL]);
    // Full, it offers no times (part 2, criterion 3); the other link still does.
    expect(await app.startsOf(first)).toEqual([]);
    // The host's other link: 30 of its own, then 429.
    const secondTimes = await app.startsOf(second);
    expect(secondTimes).toContain(firstTimes[100]);
    await bookMany(second, later(secondTimes, 30));
    expect(answer(await app.book(second, valid(secondTimes[100])))).toEqual([429, LINK_FULL]);
    expect(rowsOf(first)).toHaveLength(30);
    expect(rowsOf(second)).toHaveLength(30);
  });

  // It's the same link: the bookings it took before it was turned off still
  // count toward its hour once it's back on.
  it("keeps its count when turned off and on again", async () => {
    const a = await wideLink();
    await bookMany(a.id, later(a.times, 30));
    setNow(NOW + 10 * MIN);
    app.signIn(a.host.id);
    expect((await app.updateLink(a.id, { ...LINK, ...WIDE, active: false })).status).toBe(200);
    expect((await app.page(a.id)).status).toBe(404);
    expect((await app.updateLink(a.id, { ...LINK, ...WIDE, active: true })).status).toBe(200);
    app.signOut();
    // Still full: no times (part 2, criterion 3), and a POST is 429.
    expect(await app.startsOf(a.id)).toEqual([]);
    expect(answer(await app.book(a.id, valid(a.times[100])))).toEqual([429, LINK_FULL]);
    expect(rowsOf(a.id)).toHaveLength(30);
    // An hour after the 30, it offers times and books again.
    setNow(NOW + HOUR + 1);
    expect(await app.startsOf(a.id)).toContain(a.times[100]);
    expect((await app.book(a.id, valid(a.times[100]))).status).toBe(200);
  });
});

describe("ids a visitor can't open", () => {
  // The 404 is the same whether the id is unknown, the link is off (a full one
  // too) or its host is gone, so links can't be probed: a link that can't be
  // opened is 404 before its bookings are counted. That holds past 30 tries
  // within an hour. An open link answers bodies it can't read 400 however many
  // come, and then still takes its 30 bookings.
  it("answer alike, 404, a full link that's off included, while an open link answers 400 and then takes 30", async () => {
    const open = await wideLink();
    const full = await wideLink();
    await bookMany(full.id, later(full.times, 30));
    app.signIn(full.host.id);
    expect((await app.updateLink(full.id, { ...LINK, ...WIDE, active: false })).status).toBe(200);
    app.signOut();
    const gone = await wideLink();
    app.db.deleteUser(gone.host.id);
    const shape = (a: Answer) => ({
      status: a.status,
      json: a.json,
      type: a.headers.get("content-type"),
      robots: a.headers.get("x-robots-tag"),
      cache: a.headers.get("cache-control"),
    });
    const cases: [string, string][] = [
      ["unknown", "madeUpLinkId"],
      ["unknown, token-shaped", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      ["full link, off", full.id],
      ["host gone", gone.id],
    ];
    let first: ReturnType<typeof shape> | undefined;
    for (const [why, id] of cases) {
      for (let i = 0; i < 40; i++) {
        const a = shape(await app.book(id, valid(full.times[100 + i])));
        first ??= a;
        expect(a, `${why}, try ${i + 1}`).toEqual(first);
      }
    }
    expect(first).toMatchObject({ status: 404, json: NOT_FOUND });
    // 40 tries on the open link with a body it can't read: all 400.
    for (let i = 0; i < 40; i++) {
      const a = await app.book(open.id, invalid);
      expect([a.status, a.json], `open link, try ${i + 1}`).toEqual([400, { error: expect.any(String) }]);
    }
    expect(rowsOf(open.id)).toHaveLength(0);
    await bookMany(open.id, later(open.times, 30));
    expect(answer(await app.book(open.id, valid(open.times[100])))).toEqual([429, LINK_FULL]);
  });
});

describe("outside the demo", () => {
  const leaveTheDemo = () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  };
  const backToTheDemo = () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  };

  it("keeps nothing of a try that answers 503, so 40 of them leave the link its 30", async () => {
    leaveTheDemo();
    const a = await wideLink();
    for (let i = 0; i < 40; i++) expect(answer(await app.book(a.id, valid(a.times[40 + i]))), String(i)).toEqual([503, CANT_BOOK]);
    expect(app.bookingRows()).toEqual([]);
    // They count toward their address: five from one, then its 6th is 429.
    const A = "203.0.113.30";
    for (let i = 0; i < 5; i++) expect((await app.book(a.id, valid(a.times[40 + i]), from(A))).status, String(i)).toBe(503);
    expect(answer(await app.book(a.id, valid(a.times[45]), from(A)))).toEqual([429, TOO_MANY]);
    // In the demo again, within the hour: 30 bookings, then 429.
    backToTheDemo();
    setNow(NOW + 10 * MIN);
    await bookMany(a.id, later(a.times, 30));
    expect(answer(await app.book(a.id, valid(a.times[100])))).toEqual([429, LINK_FULL]);
  });

  it("answers 429, not 503, once the link took 30 bookings within the hour, and stores nothing", async () => {
    const a = await wideLink();
    await bookMany(a.id, later(a.times, 30));
    leaveTheDemo();
    expect(answer(await app.book(a.id, valid(a.times[100])))).toEqual([429, LINK_FULL]);
    expect(app.bookingRows()).toHaveLength(30);
  });
});
