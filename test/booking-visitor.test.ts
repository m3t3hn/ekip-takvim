import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { at, reference, type Span } from "./booking-reference";
import { CANT_BOOK, LINK, NOT_FOUND, TAKEN, bookingApp, expectToken, sha256Forms, type Answer, type Made, type Page } from "./booking-helpers";
import { captureConsole } from "./link-helpers";

// Booking links through the visitor's routes: criteria 4 (the page), 5
// (booking), 7 (cancelling with the cancel link) and 10 (what visitors and the
// log never get), and X-Robots-Tag on every answer under /api/book/. In the
// demo unless a test says otherwise. Nothing reaches the network.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "v".repeat(40);
process.env.CONFIG_YAML = CONFIG;
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.DEMO_MODE = "true";
process.env.APP_URL = "https://cal.example.com";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const app = await bookingApp(jar);
const { db, sync } = app;

const IST = "Europe/Istanbul";
/** 2026-11-<d> at hh:mm in Istanbul (UTC+3). 2026-11-18 is a Wednesday. */
const ist = (d: number, h: number, m = 0) => at(IST, 2026, 11, d, h, m);
/** Wednesday 09:00 in Istanbul. */
const NOW = ist(18, 9);
const MIN = 60_000;

let lines: string[] = [];
const tokens: string[] = [];
const guestEmails: string[] = [];
const fetches: string[] = [];

function setNow(t: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
}

/** Book through the API and keep the token and email for the privacy checks. */
async function bookAs(id: string, start: number, guest: string) {
  guestEmails.push(`${guest}@guests.example.org`);
  const token = await app.bookAs(id, start, guest);
  tokens.push(token);
  return token;
}

beforeAll(() => {
  lines = captureConsole();
});
beforeEach(() => {
  db.resetAll();
  app.signOut();
  setNow(NOW);
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.booking-limits")];
  fetches.length = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    fetches.push(String(input instanceof Request ? input.url : input));
    throw new TypeError("test: no network");
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
  process.env.CALENDAR_LINKS = "private";
  process.env.DEMO_MODE = "true";
  process.env.CONFIG_YAML = CONFIG;
  process.env.APP_URL = "https://cal.example.com";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

const until = () => sync.syncWindow(sync.getConfig()!).to.getTime();
const rule = (r: Partial<typeof LINK> = {}) => {
  const { durationMin, days, startMin, endMin, bufferMin, noticeMin, aheadDays, maxPerDay } = { ...LINK, ...r };
  return { durationMin, days, startMin, endMin, bufferMin, noticeMin, aheadDays, maxPerDay };
};

describe("GET /api/book/[id] (criterion 4)", () => {
  /**
   * A host whose busy blocks come from a Google calendar, a calendar link and a
   * calendar they don't count, with bookings on this link and another.
   */
  async function busyHost() {
    const host = app.person("Ayşe Host", {
      email: "ayse.private@example.com",
      label: "Secret Work Label",
      busy: [
        // Started days ago, still going on Wednesday morning.
        { start: ist(15, 0), end: ist(18, 10, 21), title: "Secret Trip" },
        { start: ist(19, 10, 7), end: ist(19, 10, 52), title: "Secret Dentist" },
      ],
    });
    const sideGig = db.addLinkCalendar(host.id, "https://ics.example.net/private/abc123/basic.ics", "Secret Side Gig");
    db.setBusy(host.id, sideGig, [{ start: ist(19, 11, 37), end: ist(19, 11, 44), title: "Secret Client", eventId: "side-1" }]);
    db.syncCalendarList(host.id, [
      { id: host.calendarId, summary: "Secret Work Label", access: "events", primary: true },
      { id: "personal@example.com", summary: "Secret Personal", access: "events", primary: false },
    ]);
    db.setBusy(host.id, "personal@example.com", [{ start: ist(20, 9, 59), end: ist(20, 12, 1), title: "Secret Not Counted", eventId: "p-1" }]);
    app.signIn(host.id);
    const id = await app.newLink({ title: "Coffee chat" });
    const other = await app.newLink({ title: "Other link" });
    app.signOut();
    await bookAs(other, ist(20, 10, 30), "on-other-link");
    await bookAs(id, ist(18, 11), "on-this-link");
    const cancelled = await bookAs(id, ist(20, 11, 30), "cancelled");
    expect((await app.cancel(cancelled)).status).toBe(200);
    return { host, id, other };
  }

  /** What the criteria say busyHost's link offers now, with or without the calendar link's blocks. */
  function expected(id: string, links: boolean) {
    const blocks: Span[] = [
      { start: ist(15, 0), end: ist(18, 10, 21) },
      { start: ist(19, 10, 7), end: ist(19, 10, 52) },
      ...(links ? [{ start: ist(19, 11, 37), end: ist(19, 11, 44) }] : []),
    ];
    const active = app.bookingRows().filter((b) => b.cancelled_at === null);
    const { must, may } = reference({
      rule: rule(),
      zone: IST,
      now: Date.now(),
      until: until(),
      busy: blocks,
      booked: active.map((b) => ({ start: Number(b.start_ms), end: Number(b.end_ms), here: b.link_id === id })),
    });
    expect(may).toEqual(must);
    return must;
  }

  it("answers exactly the link's title, description, length, host name and free times", async () => {
    const { id } = await busyHost();
    const a = await app.page(id);
    expect(a.status).toBe(200);
    const body = a.json as Page;
    expect(Object.keys(body).sort()).toEqual(["description", "durationMin", "fullDays", "hostName", "meet", "slots", "title"]);
    // Run 2026-11-25-ekip-quick-wins-visitor adds meet (criterion 2) and fullDays (criterion 3): no day here is full.
    expect(body).toMatchObject({ meet: false, fullDays: [] });
    expect(body).toMatchObject({ title: "Coffee chat", description: LINK.description, durationMin: 30, hostName: "Ayşe Host" });
    for (const s of body.slots) expect(Object.keys(s).sort()).toEqual(["end", "start"]);
    // By hand: Wednesday 10:00 is in the trip, 11:00 booked here; Thursday 10:00
    // and 10:30 are the dentist, 11:30 the side gig; Friday 10:30 is booked on
    // the other link, 11:30's booking was cancelled, and the uncounted calendar
    // doesn't count.
    expect(body.slots.map((s) => s.start)).toEqual([ist(18, 10, 30), ist(18, 11, 30), ist(19, 11), ist(20, 10), ist(20, 11), ist(20, 11, 30)]);
    expect(body.slots.map((s) => s.start)).toEqual(expected(id, true));
    expect(body.slots.every((s) => s.end - s.start === 30 * MIN)).toBe(true);
  });

  it("counts calendar links as /api/availability does: only while CALENDAR_LINKS lets them count", async () => {
    const { id } = await busyHost();
    process.env.CALENDAR_LINKS = "off";
    expect(await app.startsOf(id)).toEqual(expected(id, false));
    expect(await app.startsOf(id)).toContain(ist(19, 11, 30));
    process.env.CALENDAR_LINKS = "on";
    expect(await app.startsOf(id)).toEqual(expected(id, true));
    expect(await app.startsOf(id)).not.toContain(ist(19, 11, 30));
  });

  it("works in the host's zone and at the current time", async () => {
    const host = app.person("Ny Host", { zone: "America/New_York" });
    app.signIn(host.id);
    const id = await app.newLink({ aheadDays: 2, startMin: 9 * 60, endMin: 10 * 60, noticeMin: 60 });
    app.signOut();
    // Wednesday 09:00 Istanbul is 01:00 in New York: Wednesday and Thursday, 09:00 to 10:00 there.
    const ny = (d: number, h: number, m = 0) => at("America/New_York", 2026, 11, d, h, m);
    expect(await app.startsOf(id)).toEqual([ny(18, 9), ny(18, 9, 30), ny(19, 9), ny(19, 9, 30)]);
    setNow(ny(18, 8, 10));
    expect(await app.startsOf(id)).toEqual([ny(18, 9, 30), ny(19, 9), ny(19, 9, 30)]);
    setNow(ny(19, 8, 31));
    expect(await app.startsOf(id)).toEqual([ny(20, 9), ny(20, 9, 30)]);
  });

  it("ends the times at the end of the days the server syncs", async () => {
    const host = app.person("Long Host");
    app.signIn(host.id);
    const id = await app.newLink({ aheadDays: 30 });
    app.signOut();
    const far = await app.startsOf(id);
    expect(far.at(-1)).toBeGreaterThan(ist(30, 0));
    // The server now syncs a week ahead; the link still asks for 30 days.
    process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 7\n";
    expect(sync.getConfig()!.horizonDays).toBe(7);
    const slots = await app.slotsOf(id);
    const { must, may } = reference({ rule: rule({ aheadDays: 30 }), zone: IST, now: Date.now(), until: until(), busy: [], booked: [] });
    expect(may).toEqual(must);
    expect(slots.map((s) => s.start)).toEqual(must);
    expect(slots.at(-1)!.end).toBeLessThanOrEqual(until());
    // Wednesday the 25th is the last day with times: the 26th starts after the synced days end.
    expect(slots.at(-1)!.start).toBe(ist(25, 11, 30));
  });

  it("offers no times while the host's data isn't ok", async () => {
    const page = async (host: { id: string }) => {
      app.signIn(host.id);
      const id = await app.newLink({ title: "Some link" });
      app.signOut();
      const a = await app.page(id);
      expect(a.status).toBe(200);
      return a.json as Page;
    };
    // Syncing: a calendar that hasn't been read yet.
    const syncing = app.person("Syncing Host", { calendar: false });
    db.syncCalendarList(syncing.id, [{ id: "s@example.com", summary: "Work", access: "events", primary: true }]);
    // Failing: one that couldn't be read.
    const failing = app.person("Failing Host", { calendar: false });
    db.syncCalendarList(failing.id, [{ id: "f@example.com", summary: "Work", access: "events", primary: true }]);
    db.setCalendarError(failing.id, "f@example.com", "Google refused to share this calendar");
    // Sign in again: Google refused their token.
    const lapsed = app.person("Lapsed Host");
    db.setTokenError(lapsed.id, "Google access expired or was revoked");
    // No calendars that count.
    const none = app.person("Empty Host", { calendar: false });
    const unticked = app.person("Unticked Host");
    db.updateCalendarChoices(unticked.id, [{ id: unticked.calendarId, label: "Work", included: false }]);
    // And one that's ok, to show the link would offer times.
    const fine = app.person("Fine Host");
    expect((await page(fine)).slots.length).toBe(12);
    for (const host of [syncing, failing, lapsed, none, unticked]) {
      const body = await page(host);
      expect(body.slots, host.name).toEqual([]);
      expect(body.hostName).toBe(host.name);
    }
  });

  it("offers no times outside the demo while the host's data is old or their Google access is gone", async () => {
    process.env.DEMO_MODE = "";
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    const { id } = await app.hostWithLink();
    expect(await app.slotsOf(id)).toHaveLength(12);
    setNow(NOW + 6 * 60 * MIN + MIN);
    expect(await app.slotsOf(id)).toEqual([]);
    setNow(NOW);
    const { id: noToken } = await app.hostWithLink({}, { refreshToken: false });
    expect(await app.slotsOf(noToken)).toEqual([]);
  });

  it("answers the same 404 when booking is off, the id is unknown, the link is off or its host is gone", async () => {
    const { id } = await app.hostWithLink();
    const { id: offLink, host: offHost } = await app.hostWithLink();
    app.signIn(offHost.id);
    expect((await app.updateLink(offLink, { ...LINK, title: "Off", active: false })).status).toBe(200);
    app.signOut();
    const { id: goneLink, host: goneHost } = await app.hostWithLink();
    db.deleteUser(goneHost.id);
    expect((await app.page(id)).status).toBe(200);

    const answers: [string, Answer][] = [];
    for (const setting of [undefined, "", "off", "OFF", "maybe"]) {
      if (setting === undefined) delete process.env.BOOKING_LINKS;
      else process.env.BOOKING_LINKS = setting;
      answers.push([`BOOKING_LINKS=${setting}`, await app.page(id)]);
    }
    process.env.BOOKING_LINKS = "on";
    answers.push(["unknown", await app.page("doesNotExist")]);
    answers.push(["unknown, token-shaped", await app.page("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]);
    answers.push(["link off", await app.page(offLink)]);
    answers.push(["host gone", await app.page(goneLink)]);
    const shape = (a: Answer) => ({
      status: a.status,
      json: a.json,
      type: a.headers.get("content-type"),
      robots: a.headers.get("x-robots-tag"),
      cache: a.headers.get("cache-control"),
    });
    for (const [why, a] of answers) {
      expect(a.status, why).toBe(404);
      expect(a.json, why).toEqual(NOT_FOUND);
      expect(shape(a), why).toEqual(shape(answers[0][1]));
    }
  });
});

describe("POST /api/book/[id] (criterion 5)", () => {
  const guest = { name: "Deniz Guest", email: "deniz@guests.example.org", note: "About the project" };

  it("is 400, with a plain message, for a name, email, note or start that isn't right", async () => {
    const { id } = await app.hostWithLink();
    const start = ist(18, 10);
    const bad: [string, unknown][] = [
      ["empty name", { ...guest, start, name: "" }],
      ["blank name", { ...guest, start, name: "   " }],
      ["101-character name", { ...guest, start, name: "n".repeat(101) }],
      ["missing name", { start, email: guest.email }],
      ["name not text", { ...guest, start, name: 42 }],
      ["no @", { ...guest, start, email: "deniz.guests.example.org" }],
      ["no domain", { ...guest, start, email: "deniz@" }],
      ["two @", { ...guest, start, email: "deniz@@guests.example.org" }],
      ["space", { ...guest, start, email: "de niz@guests.example.org" }],
      ["empty email", { ...guest, start, email: "" }],
      ["missing email", { start, name: guest.name }],
      ["255-character email", { ...guest, start, email: `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com` }],
      ["501-character note", { ...guest, start, note: "x".repeat(501) }],
      ["start as text", { ...guest, start: String(start) }],
      ["start null", { ...guest, start: null }],
      ["no start", { ...guest }],
      ["start not a number", { ...guest, start: "tomorrow" }],
    ];
    for (const [why, body] of bad) {
      const a = await app.book(id, body);
      expect(a.status, why).toBe(400);
      expect(a.json, why).toEqual({ error: expect.any(String) });
      expect((a.json as { error: string }).error.length, why).toBeGreaterThan(0);
    }
    expect((await app.book(id, "{not json")).status).toBe(400);
    expect(app.bookingRows()).toEqual([]);
    // The longest of each still books.
    const email254 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
    expect(email254).toHaveLength(254);
    const ok = await app.book(id, { start, name: ` ${"n".repeat(100)} `, email: email254, note: "x".repeat(500) });
    expect(ok.status, ok.text).toBe(200);
    expect((await app.book(id, { start: ist(18, 10, 30), name: guest.name, email: "x@guests.example.org" })).status).toBe(200);
    expect(app.bookingRows()).toHaveLength(2);
  });

  it("is 404, as GET is, when booking is off, the id is unknown, the link is off or its host is gone", async () => {
    const { id } = await app.hostWithLink();
    const { id: offLink, host: offHost } = await app.hostWithLink();
    app.signIn(offHost.id);
    expect((await app.updateLink(offLink, { ...LINK, active: false })).status).toBe(200);
    app.signOut();
    const { id: goneLink, host: goneHost } = await app.hostWithLink();
    db.deleteUser(goneHost.id);
    const body = { ...guest, start: ist(18, 10) };
    for (const setting of [undefined, "off", "maybe"]) {
      if (setting === undefined) delete process.env.BOOKING_LINKS;
      else process.env.BOOKING_LINKS = setting;
      const a = await app.book(id, body);
      expect([a.status, a.json], String(setting)).toEqual([404, NOT_FOUND]);
    }
    process.env.BOOKING_LINKS = "on";
    for (const unknown of ["doesNotExist", offLink, goneLink]) {
      const a = await app.book(unknown, body);
      expect([a.status, a.json], unknown).toEqual([404, NOT_FOUND]);
    }
    expect(app.bookingRows()).toEqual([]);
  });

  it("is 409 for a start GET doesn't offer at that moment", async () => {
    const { id } = await app.hostWithLink({ noticeMin: 60 }, { busy: [{ start: ist(19, 10), end: ist(19, 11) }] });
    const offered = await app.startsOf(id);
    expect(offered).toContain(ist(18, 10));
    const notOffered = [
      ist(18, 10) + MIN, // off the steps
      ist(18, 9, 30), // before the window, and within the notice
      ist(19, 10), // busy
      ist(19, 10, 30), // busy
      ist(18, 12), // the window's end
      ist(23, 10), // past the days ahead
      ist(17, 10), // yesterday
      ist(21, 10), // a Saturday
      0,
      -1,
      ist(18, 10) + 0.5,
    ];
    for (const start of notOffered) {
      expect(offered).not.toContain(start);
      const a = await app.book(id, { ...guest, start });
      expect([a.status, a.json], String(start)).toEqual([409, TAKEN]);
    }
    expect(app.bookingRows()).toEqual([]);
    // A time the notice has since overtaken.
    setNow(ist(18, 9, 1));
    const late = await app.book(id, { ...guest, start: ist(18, 10) });
    expect([late.status, late.json]).toEqual([409, TAKEN]);
    // And one booked already.
    expect((await app.book(id, { ...guest, start: ist(18, 11) })).status).toBe(200);
    const again = await app.book(id, { ...guest, start: ist(18, 11) });
    expect([again.status, again.json]).toEqual([409, TAKEN]);
  });

  it("books an offered time: 200 with the time, title, host name and a cancel link", async () => {
    const { id, host } = await app.hostWithLink({ title: "Portfolio review" }, { name: "Ayşe Host" });
    const start = ist(19, 11);
    const a = await app.book(id, { ...guest, start });
    expect(a.status, a.text).toBe(200);
    const made = a.json as Made;
    // Part 2 (criterion 8) adds invited, false in the demo.
    expect(Object.keys(made).sort()).toEqual(["cancelUrl", "end", "hostName", "invited", "start", "title"]);
    expect(made).toMatchObject({ start, end: start + 30 * MIN, title: "Portfolio review", hostName: "Ayşe Host", invited: false });
    // The app's URL (APP_URL), /book/cancel/, and the token.
    expect(made.cancelUrl).toMatch(/^https:\/\/cal\.example\.com\/book\/cancel\/[A-Za-z0-9_-]+$/);
    const token = made.cancelUrl.split("/").pop()!;
    tokens.push(token);
    guestEmails.push(guest.email);
    expectToken(token);

    // Stored, with only the token's SHA-256.
    const rows = app.bookingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: host.id,
      link_id: id,
      title: "Portfolio review",
      start_ms: start,
      end_ms: start + 30 * MIN,
      guest_name: guest.name,
      guest_email: guest.email,
      note: guest.note,
      cancelled_at: null,
      event_id: null,
      calendar_id: null,
    });
    expect(sha256Forms(token)).toContain(rows[0].cancel_hash);
    expect(app.everything()).not.toContain(token);
    expect(await app.startsOf(id)).not.toContain(start);
  });

  it("gives every booking its own cancel token", async () => {
    const { id } = await app.hostWithLink({ aheadDays: 5 });
    const starts = (await app.startsOf(id)).slice(0, 6);
    const mine = [];
    for (const start of starts) mine.push(await bookAs(id, start, `many${start}`));
    expect(new Set(mine).size).toBe(6);
    for (const t of mine) expectToken(t);
  });

  it("takes the time from GET, and with the link's buffer the times around it, but only this link's buffer", async () => {
    const host = app.person("Buffer Host");
    app.signIn(host.id);
    const buffered = await app.newLink({ bufferMin: 15 });
    const plain = await app.newLink({});
    app.signOut();
    expect(await app.startsOf(buffered)).toEqual([ist(18, 10), ist(18, 10, 30), ist(18, 11), ist(18, 11, 30), ...[19, 20].flatMap((d) => [ist(d, 10), ist(d, 10, 30), ist(d, 11), ist(d, 11, 30)])]);
    await bookAs(buffered, ist(19, 10, 30), "buffered");
    const after = await app.startsOf(buffered);
    // 10:00 and 11:00 come within 15 minutes of 10:30 to 11:00.
    expect(after.filter((t) => t >= ist(19, 0) && t < ist(20, 0))).toEqual([ist(19, 11, 30)]);
    expect(after.filter((t) => t < ist(19, 0) || t >= ist(20, 0))).toHaveLength(8);
    // The other link has no buffer: it loses that time only.
    expect((await app.startsOf(plain)).filter((t) => t >= ist(19, 0) && t < ist(20, 0))).toEqual([ist(19, 10), ist(19, 11), ist(19, 11, 30)]);
  });

  it("lets only one of two requests for the same time win", async () => {
    const { id } = await app.hostWithLink();
    const start = ist(18, 10, 30);
    const both = await Promise.all([app.book(id, { ...guest, start }), app.book(id, { ...guest, email: "other@guests.example.org", start })]);
    expect(both.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(both.find((a) => a.status === 409)!.json).toEqual(TAKEN);
    expect(app.bookingRows()).toHaveLength(1);
  });

  it("lets only one win when the two are for the same time on two of the host's links, or for overlapping times", async () => {
    const host = app.person("Two Links");
    app.signIn(host.id);
    const first = await app.newLink({});
    const second = await app.newLink({});
    const hour = await app.newLink({ durationMin: 60 });
    app.signOut();
    const sameTime = await Promise.all([app.book(first, { ...guest, start: ist(19, 10) }), app.book(second, { ...guest, start: ist(19, 10) })]);
    expect(sameTime.map((a) => a.status).sort()).toEqual([200, 409]);
    const overlapping = await Promise.all([app.book(hour, { ...guest, start: ist(20, 10) }), app.book(hour, { ...guest, start: ist(20, 10, 30) })]);
    expect(overlapping.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(app.bookingRows()).toHaveLength(2);
  });

  // Part 2: outside the demo a booking asks Google (criterion 5). This file's
  // fetch throws, so Google can't be reached: 503, and nothing is kept.
  it("outside the demo, with Google out of reach, answers 503 and stores nothing", async () => {
    process.env.DEMO_MODE = "true";
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    const { id } = await app.hostWithLink();
    const start = ist(18, 10, 30);
    expect(await app.startsOf(id)).toContain(start);
    const a = await app.book(id, { ...guest, start });
    expect([a.status, a.json]).toEqual([503, CANT_BOOK]);
    expect(app.bookingRows()).toEqual([]);
    expect(await app.startsOf(id)).toContain(start);
    // Twice, and with DEMO_MODE unset.
    delete process.env.DEMO_MODE;
    const b = await app.book(id, { ...guest, start });
    expect([b.status, b.json]).toEqual([503, CANT_BOOK]);
    expect(app.bookingRows()).toEqual([]);
    expect(await app.startsOf(id)).toContain(start);
    // It tried Google, and nothing else.
    expect(fetches.length).toBeGreaterThan(0);
    for (const url of fetches) expect(url).toMatch(/^https:\/\/(oauth2|www)\.googleapis\.com\//);
  });

  it("outside the demo answers 409 while the host's data isn't ok, as GET offers nothing", async () => {
    delete process.env.DEMO_MODE;
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    const { id } = await app.hostWithLink();
    setNow(NOW + 7 * 60 * MIN);
    const a = await app.book(id, { ...guest, start: ist(19, 10) });
    expect([a.status, a.json]).toEqual([409, TAKEN]);
    expect(app.bookingRows()).toEqual([]);
  });
});

describe("cancelling with the cancel link (criterion 7)", () => {
  it("shows the booking: its title, time, host name and whether it's cancelled", async () => {
    const { id } = await app.hostWithLink({ title: "Design review" }, { name: "Mert Host" });
    const token = await bookAs(id, ist(19, 11), "shown");
    const a = await app.cancelInfo(token);
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ title: "Design review", start: ist(19, 11), end: ist(19, 11, 30), hostName: "Mert Host", cancelled: false, ended: false, bookAgain: null });
  });

  it("is 404 for a token that isn't a booking's", async () => {
    const { id } = await app.hostWithLink();
    const token = await bookAs(id, ist(19, 11), "unknown");
    const changed = (token[0] === "A" ? "B" : "A") + token.slice(1);
    // Nor does the stored hash work as a token, in any spelling.
    for (const t of ["nope", changed, token.slice(1), `${token}x`, ...sha256Forms(token)]) {
      expect((await app.cancelInfo(t)).status, t).toBe(404);
      expect((await app.cancel(t)).status, t).toBe(404);
    }
    expect(app.bookingRows()[0].cancelled_at).toBeNull();
  });

  it("cancels the booking, offers its time again, and changes nothing the second time", async () => {
    const { id } = await app.hostWithLink();
    const start = ist(19, 11);
    const token = await bookAs(id, start, "canceller");
    expect(await app.startsOf(id)).not.toContain(start);
    setNow(NOW + 5 * MIN);
    const first = await app.cancel(token);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ cancelled: true, start });
    const row = app.bookingRows()[0];
    expect(row.cancelled_at).toEqual(expect.any(Number));
    expect(await app.startsOf(id)).toContain(start);
    expect((await app.cancelInfo(token)).json).toMatchObject({ cancelled: true });

    setNow(NOW + 10 * MIN);
    const second = await app.cancel(token);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ cancelled: true });
    expect(app.bookingRows()).toEqual([row]);
  });

  it("is 404 while booking is off", async () => {
    const { id } = await app.hostWithLink();
    const token = await bookAs(id, ist(19, 11), "off");
    process.env.BOOKING_LINKS = "off";
    expect((await app.cancelInfo(token)).status).toBe(404);
    expect((await app.cancel(token)).status).toBe(404);
    expect(app.bookingRows()[0].cancelled_at).toBeNull();
  });
});

describe("what visitors and the log never get (criterion 10)", () => {
  it("keeps the host's email, calendar labels, event titles, busy blocks and other guests out of every answer", async () => {
    const busy = [
      { start: ist(18, 10, 7), end: ist(18, 10, 22), title: "Secret Standup" },
      { start: ist(19, 13, 11), end: ist(19, 14, 49), title: "Secret Lunch" },
    ];
    const host = app.person("Privacy Host", { email: "privacy.host@example.com", label: "Secret Calendar Label", busy });
    const linkCal = db.addLinkCalendar(host.id, "https://ics.example.net/private/zz9/basic.ics", "Secret Link Label");
    db.setBusy(host.id, linkCal, [{ start: ist(20, 10, 41), end: ist(20, 10, 43), title: "Secret Link Event", eventId: "l1" }]);
    app.signIn(host.id);
    const id = await app.newLink({ title: "Open hours", description: "Ask me anything" });
    const other = await app.newLink({ title: "Other hours" });
    app.signOut();

    // Each answer, with the guest whose booking it is about, if any.
    const answers: { text: string; own: string | null }[] = [];
    const keep = async (own: string | null, call: Promise<unknown>) => {
      await call;
      answers.push({ text: app.visitorAnswers.at(-1)!.text, own });
    };
    let first = "";
    let second = "";
    await keep("firstguest", bookAs(id, ist(18, 11), "firstguest").then((t) => (first = t)));
    await keep(null, app.page(id));
    await keep(null, app.page(other));
    await keep("secondguest", bookAs(other, ist(19, 11), "secondguest").then((t) => (second = t)));
    await keep(null, app.page(id));
    await keep("firstguest", app.cancelInfo(first));
    await keep("secondguest", app.cancelInfo(second));
    await keep("firstguest", app.cancel(first));
    await keep("thirdguest", app.book(id, { start: ist(19, 10), name: "Guest thirdguest", email: "thirdguest@guests.example.org" }));
    await keep(null, app.page(id));
    await keep(null, app.page(other));
    expect(answers.map((a) => a.text.slice(0, 12))).toHaveLength(11);
    const never = [
      "privacy.host@example.com",
      "Secret Calendar Label",
      "Secret Link Label",
      "Secret Standup",
      "Secret Lunch",
      "Secret Link Event",
      "zz9",
      ...[...busy, { start: ist(20, 10, 41), end: ist(20, 10, 43) }].flatMap((b) => [String(b.start), String(b.end), new Date(b.start).toISOString()]),
    ];
    for (const a of answers) {
      for (const secret of never) expect(a.text).not.toContain(secret);
      // A booking's own answers might speak of its guest; nothing may speak of another's.
      for (const g of ["firstguest", "secondguest", "thirdguest"]) {
        if (g === a.own) continue;
        expect(a.text).not.toContain(`Guest ${g}`);
        expect(a.text).not.toContain(`${g}@guests.example.org`);
      }
    }
  });

  it("never logs a cancel token or a guest's email", () => {
    // Runs last: every booking in this file has been made by now.
    expect(tokens.length).toBeGreaterThan(10);
    const log = lines.join("\n");
    for (const token of tokens) expect(log).not.toContain(token);
    for (const email of guestEmails) expect(log).not.toContain(email);
    expect(log).not.toContain("@guests.example.org");
  });
});

