import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MyBookingLinks } from "@/lib/types";
import { at } from "./booking-reference";
import { BOOKING_OFF, LINK, NOT_FOUND, bookingApp, expectToken, type LinkBody } from "./booking-helpers";
import { captureConsole } from "./link-helpers";

// Booking links through the host's routes: criterion 8, and criterion 7's
// cancelling by the host (POST /api/me/bookings/[id]/cancel). In the demo,
// with BOOKING_LINKS=on unless a test says otherwise.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "h".repeat(40);
process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 21\n";
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.DEMO_MODE = "true";
process.env.APP_URL = "https://cal.example.com";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const app = await bookingApp(jar);
const { db } = app;
const meRoute = await import("@/app/api/me/route");

/** 2026-11-<d> at hh:mm in Istanbul. 2026-11-18 is a Wednesday. */
const ist = (d: number, h: number, m = 0) => at("Europe/Istanbul", 2026, 11, d, h, m);
const NOW = ist(18, 9);
const MIN = 60_000;
const HORIZON = 21;

const setNow = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};
const mine = (a: { json: unknown }) => a.json as MyBookingLinks;
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
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("test: no network");
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
});

/** Signed in as a new host with one link; the host and the link's id. */
async function signedInHost(name = "Ahmet Host", body: Partial<LinkBody> = {}) {
  const host = app.person(name);
  app.signIn(host.id);
  return { host, id: await app.newLink(body) };
}

/** Book a time on a link as a visitor, staying signed in as whoever is; the booking's id. */
async function booked(linkId: string, start: number, guest: string) {
  const session = jar.session;
  tokens.push(await app.bookAs(linkId, start, guest));
  jar.session = session;
  const row = app.bookingRows().find((b) => b.start_ms === start && b.guest_email === `${guest}@guests.example.org`)!;
  return String(row.id);
}

describe("who may use the host API (criterion 8)", () => {
  const calls = (id: string, bookingId: string) =>
    [
      ["GET", () => app.myLinks()],
      ["POST", () => app.createLink(LINK)],
      ["PUT", () => app.updateLink(id, { ...LINK, active: true })],
      ["DELETE", () => app.deleteLink(id)],
      ["cancel", () => app.cancelMine(bookingId)],
    ] as const;

  it("is 401 without a session, or with one that no longer holds", async () => {
    const { host, id } = await signedInHost();
    const bookingId = await booked(id, ist(19, 10), "anon");
    app.signOut();
    for (const [what, call] of calls(id, bookingId)) {
      const a = await call();
      expect([a.status, a.json], what).toEqual([401, { error: "Sign in first" }]);
    }
    app.signIn(host.id);
    db.bumpSessionVersion(host.id);
    for (const [what, call] of calls(id, bookingId)) expect((await call()).status, what).toBe(401);
    expect(app.linkRows()).toHaveLength(1);
    expect(app.bookingRows()[0].cancelled_at).toBeNull();
  });

  it("is 403 while booking links are off, or BOOKING_LINKS is neither on nor off", async () => {
    const { id } = await signedInHost();
    const bookingId = await booked(id, ist(19, 10), "off");
    for (const setting of [undefined, "", "off", "Off", "yes", "true"]) {
      if (setting === undefined) delete process.env.BOOKING_LINKS;
      else process.env.BOOKING_LINKS = setting;
      for (const [what, call] of calls(id, bookingId)) {
        const a = await call();
        expect([a.status, a.json], `${setting} ${what}`).toEqual([403, BOOKING_OFF]);
      }
    }
    expect(app.linkRows()).toHaveLength(1);
    expect(app.bookingRows()[0].cancelled_at).toBeNull();
  });
});

describe("making and changing links (criterion 8)", () => {
  it("POST makes a link and answers with GET's shape: its fields, and its path /book/<id>", async () => {
    const host = app.person("Ahmet Host");
    app.signIn(host.id);
    const body = { ...LINK, title: "Portfolio review", description: "Bring your work", durationMin: 45, days: [0, 6], startMin: 8 * 60 + 15, endMin: 20 * 60, bufferMin: 10, noticeMin: 2880, aheadDays: HORIZON, maxPerDay: 20, meet: true };
    const a = await app.createLink(body);
    expect(a.status, a.text).toBe(200);
    // Part 2 (criterion 3) adds bookingAccess, the host's stored booking_access.
    expect(Object.keys(a.json as object).sort()).toEqual(["bookingAccess", "links", "upcoming"]);
    expect(mine(a).bookingAccess).toBe(true);
    expect(a.json).toEqual((await app.myLinks()).json);
    const [link] = mine(a).links;
    expect(link).toMatchObject({ ...body, active: true });
    expect(link.path).toBe(`/book/${link.id}`);
    expectToken(link.id);
    expect(mine(a).upcoming).toEqual([]);
    // The page answers at that path.
    expect((await app.page(link.path.slice(6))).status).toBe(200);
  });

  it("gives every link an id of its own", async () => {
    const { id } = await signedInHost();
    const ids = [id];
    for (let i = 0; i < 5; i++) ids.push(await app.newLink());
    expect(new Set(ids).size).toBe(6);
    ids.forEach(expectToken);
  });

  it("is 400 for each field that isn't right, on POST and PUT", async () => {
    const { id } = await signedInHost();
    const before = app.linkRows();
    const bad: [string, Record<string, unknown>][] = [
      ["empty title", { title: "" }],
      ["blank title", { title: "    " }],
      ["81-character title", { title: "t".repeat(81) }],
      ["title not text", { title: 5 }],
      ["501-character description", { description: "d".repeat(501) }],
      ["length 20", { durationMin: 20 }],
      ["length 0", { durationMin: 0 }],
      ["length 240", { durationMin: 240 }],
      ["length as text", { durationMin: "30" }],
      ["no days", { days: [] }],
      ["day 7", { days: [1, 7] }],
      ["day -1", { days: [-1] }],
      ["a day twice", { days: [1, 2, 1] }],
      ["day 1.5", { days: [1.5] }],
      ["days not a list", { days: 1 }],
      ["start off the quarter hours", { startMin: 610 }],
      ["end off the quarter hours", { endMin: 725 }],
      ["start below 0", { startMin: -15 }],
      ["end past 1440", { endMin: 1455 }],
      ["window shorter than the length", { startMin: 600, endMin: 615 }],
      ["window ending before it starts", { startMin: 720, endMin: 600 }],
      ["buffer 20", { bufferMin: 20 }],
      ["buffer 60", { bufferMin: 60 }],
      ["notice 30", { noticeMin: 30 }],
      ["notice 4320", { noticeMin: 4320 }],
      ["0 days ahead", { aheadDays: 0 }],
      ["past the horizon", { aheadDays: HORIZON + 1 }],
      ["1.5 days ahead", { aheadDays: 1.5 }],
      ["0 per day", { maxPerDay: 0 }],
      ["21 per day", { maxPerDay: 21 }],
      ["1.5 per day", { maxPerDay: 1.5 }],
      ["meet as text", { meet: "yes" }],
      ["meet as 1", { meet: 1 }],
    ];
    for (const [why, change] of bad) {
      const post = await app.createLink({ ...LINK, ...change });
      expect(post.status, `POST ${why}`).toBe(400);
      const put = await app.updateLink(id, { ...LINK, active: true, ...change });
      expect(put.status, `PUT ${why}`).toBe(400);
    }
    expect((await app.createLink({ ...LINK, title: undefined })).status).toBe(400);
    for (const active of ["yes", 1, null]) expect((await app.updateLink(id, { ...LINK, active })).status, String(active)).toBe(400);
    expect((await app.createLink("{not json")).status).toBe(400);
    expect(app.linkRows()).toEqual(before);
  });

  it("takes the edges of each field", async () => {
    const { id } = await signedInHost();
    const good: Record<string, unknown>[] = [
      { title: "t".repeat(80), description: "d".repeat(500) },
      { title: "  Padded  ", description: "" },
      ...[15, 30, 45, 60, 90, 120].map((durationMin) => ({ durationMin, startMin: 0, endMin: 1440 })),
      { durationMin: 120, startMin: 600, endMin: 720 },
      { days: [0, 1, 2, 3, 4, 5, 6] },
      { days: [6] },
      ...[0, 5, 10, 15, 30].map((bufferMin) => ({ bufferMin })),
      ...[0, 60, 120, 240, 720, 1440, 2880].map((noticeMin) => ({ noticeMin })),
      { aheadDays: 1 },
      { aheadDays: HORIZON },
      { maxPerDay: 1 },
      { maxPerDay: 20 },
      { maxPerDay: null },
      { meet: true },
    ];
    for (const change of good) {
      const put = await app.updateLink(id, { ...LINK, active: true, ...change });
      expect(put.status, `PUT ${JSON.stringify(change).slice(0, 80)} ${put.text}`).toBe(200);
    }
    // Ten links at most, so POST a few of them only.
    for (const change of good.slice(0, 8)) {
      const post = await app.createLink({ ...LINK, ...change });
      expect(post.status, `POST ${JSON.stringify(change).slice(0, 80)} ${post.text}`).toBe(200);
    }
  });

  it("answers 409 for a person's 11th link, and lets someone else make theirs", async () => {
    await signedInHost("Full Host");
    for (let i = 2; i <= 10; i++) await app.newLink();
    const eleventh = await app.createLink({ ...LINK, title: "Eleventh" });
    expect(eleventh.status).toBe(409);
    expect(mine(await app.myLinks()).links).toHaveLength(10);
    const other = app.person("Other Host");
    app.signIn(other.id);
    expect((await app.createLink(LINK)).status).toBe(200);
  });

  it("PUT changes a link, active included, and answers with GET's shape", async () => {
    const { id } = await signedInHost();
    const changed = { ...LINK, title: "Renamed", description: "New words", durationMin: 60, days: [2, 4], startMin: 540, endMin: 1020, bufferMin: 30, noticeMin: 1440, aheadDays: 10, maxPerDay: 3, meet: true, active: false };
    const a = await app.updateLink(id, changed);
    expect(a.status, a.text).toBe(200);
    expect(a.json).toEqual((await app.myLinks()).json);
    expect(mine(a).links).toEqual([{ ...changed, id: expect.any(String), path: `/book/${id}` }].map((l) => expect.objectContaining(l)));
    // Off: its page is gone. On again: it's back.
    expect((await app.page(id)).json).toEqual(NOT_FOUND);
    expect((await app.updateLink(id, { ...changed, active: true })).status).toBe(200);
    expect((await app.page(id)).status).toBe(200);
  });

  it("is 404 for PUT, DELETE or cancel on someone else's link or booking, or an unknown id, and changes nothing", async () => {
    const { id: theirs } = await signedInHost("Their Host");
    const theirBooking = await booked(theirs, ist(19, 10), "theirs");
    const before = { links: app.linkRows(), bookings: app.bookingRows() };
    const me = app.person("Me Host");
    app.signIn(me.id);
    const myLink = await app.newLink();
    const myBooking = await booked(myLink, ist(19, 11), "mine");
    for (const id of [theirs, "doesNotExist", theirBooking, myBooking]) {
      const put = await app.updateLink(id, { ...LINK, title: "Taken over", active: false });
      expect([put.status, id]).toEqual([404, id]);
      const del = await app.deleteLink(id);
      expect([del.status, id]).toEqual([404, id]);
    }
    for (const id of [theirBooking, "doesNotExist", theirs, myLink]) {
      const cancel = await app.cancelMine(id);
      expect([cancel.status, id]).toEqual([404, id]);
    }
    expect(app.linkRows().filter((l) => l.id === theirs)).toEqual(before.links);
    expect(app.bookingRows().filter((b) => b.id === theirBooking)).toEqual(before.bookings);
    expect((await app.page(theirs)).status).toBe(200);
  });
});

describe("deleting a link (criterion 8)", () => {
  it("removes the link, so its page answers 404, and keeps its bookings, which still take the host's time on other links", async () => {
    const { host, id } = await signedInHost();
    const other = await app.newLink({ title: "Still here" });
    const bookingId = await booked(id, ist(19, 10, 30), "kept");
    expect(await app.startsOf(other)).not.toContain(ist(19, 10, 30));

    const a = await app.deleteLink(id);
    expect(a.status).toBe(200);
    expect(a.json).toEqual((await app.myLinks()).json);
    expect(mine(a).links.map((l) => l.title)).toEqual(["Still here"]);
    expect([(await app.page(id)).status, (await app.page(id)).json]).toEqual([404, NOT_FOUND]);
    expect([(await app.book(id, { start: ist(19, 11), name: "Late", email: "late@guests.example.org" })).status]).toEqual([404]);

    // The booking stays, with no link, and keeps its time.
    expect(app.bookingRows()).toEqual([expect.objectContaining({ id: bookingId, user_id: host.id, link_id: null, cancelled_at: null })]);
    expect(mine(a).upcoming.map((b) => b.id)).toEqual([bookingId]);
    expect(await app.startsOf(other)).not.toContain(ist(19, 10, 30));
    expect(await app.startsOf(other)).toContain(ist(19, 11));
    // And the host can still cancel it.
    expect((await app.cancelMine(bookingId)).status).toBe(200);
    expect(await app.startsOf(other)).toContain(ist(19, 10, 30));
  });
});

describe("GET /api/me/booking-links (criterion 8)", () => {
  it("lists only the signed-in person's links and upcoming bookings", async () => {
    const { id: a1 } = await signedInHost("Ahmet Host");
    const a2 = await app.newLink({ title: "Ahmet's second" });
    const elif = app.person("Elif Host");
    app.signIn(elif.id);
    const e1 = await app.newLink({ title: "Elif's" });
    const eBooking = await booked(e1, ist(19, 10), "foreli");
    expect(app.bookingRows()).toHaveLength(1);
    const elifView = mine(await app.myLinks());
    expect(elifView.links.map((l) => l.title)).toEqual(["Elif's"]);
    expect(elifView.upcoming.map((b) => b.id)).toEqual([eBooking]);

    const ahmetRow = app.db.listUsers().find((u) => u.name === "Ahmet Host")!;
    app.signIn(ahmetRow.id);
    const aBooking = await booked(a2, ist(20, 11), "forahmet");
    const ahmetView = mine(await app.myLinks());
    expect(ahmetView.links.map((l) => l.path).sort()).toEqual([`/book/${a1}`, `/book/${a2}`].sort());
    expect(ahmetView.upcoming.map((b) => b.id)).toEqual([aBooking]);
  });

  it("lists active bookings that end after now, soonest first, with the guest's details and the title when booked", async () => {
    // Wednesday to the next Monday.
    const { id } = await signedInHost("Ahmet Host", { title: "First title", aheadDays: 6 });
    const later = await booked(id, ist(20, 11), "later");
    const soon = await booked(id, ist(18, 10), "soon");
    const middle = await booked(id, ist(19, 10, 30), "middle");
    const cancelled = await booked(id, ist(19, 11), "cancelled");
    expect((await app.cancelMine(cancelled)).status).toBe(200);
    // The title changes after these were booked.
    expect((await app.updateLink(id, { ...LINK, aheadDays: 6, title: "Second title", active: true })).status).toBe(200);
    const next = await booked(id, ist(23, 10), "next");

    const upcoming = mine(await app.myLinks()).upcoming;
    expect(upcoming.map((b) => b.id)).toEqual([soon, middle, later, next]);
    expect(upcoming[0]).toEqual({
      id: soon,
      title: "First title",
      start: ist(18, 10),
      end: ist(18, 10, 30),
      guestName: "Guest soon",
      guestEmail: "soon@guests.example.org",
      note: "Note from soon",
    });
    expect(upcoming.map((b) => b.title)).toEqual(["First title", "First title", "First title", "Second title"]);

    // In progress: still listed. Over: gone.
    setNow(ist(18, 10, 29));
    expect(mine(await app.myLinks()).upcoming.map((b) => b.id)).toEqual([soon, middle, later, next]);
    setNow(ist(18, 10, 30));
    expect(mine(await app.myLinks()).upcoming.map((b) => b.id)).toEqual([middle, later, next]);
    setNow(ist(23, 10, 30));
    expect(mine(await app.myLinks()).upcoming).toEqual([]);
  });
});

describe("cancelling as the host (criterion 7)", () => {
  it("cancels the host's own booking, offers its time again, and changes nothing the second time", async () => {
    const { id } = await signedInHost();
    const start = ist(19, 10);
    const bookingId = await booked(id, start, "hostcancel");
    expect(await app.startsOf(id)).not.toContain(start);
    setNow(NOW + 5 * MIN);
    const a = await app.cancelMine(bookingId);
    expect(a.status).toBe(200);
    expect(a.json).toEqual((await app.myLinks()).json);
    expect(mine(a).upcoming).toEqual([]);
    const row = app.bookingRows()[0];
    expect(row.cancelled_at).toEqual(expect.any(Number));
    expect(await app.startsOf(id)).toContain(start);

    setNow(NOW + 10 * MIN);
    const again = await app.cancelMine(bookingId);
    expect(again.status).toBe(200);
    expect(app.bookingRows()).toEqual([row]);
  });
});

describe("Remove me (criterion 2, through DELETE /api/me)", () => {
  it("deletes the person's booking links and bookings, so their pages answer 404, and leaves everyone else's", async () => {
    const { host, id } = await signedInHost("Leaving Host");
    await booked(id, ist(19, 10), "leaving");
    const { id: staying } = await signedInHost("Staying Host");
    await booked(staying, ist(19, 10), "staying");
    app.signIn(host.id);
    const res = await meRoute.DELETE();
    expect(res.status).toBe(200);
    expect(app.linkRows().map((l) => l.user_id)).not.toContain(host.id);
    expect(app.bookingRows().map((b) => b.user_id)).not.toContain(host.id);
    expect(app.linkRows()).toHaveLength(1);
    expect(app.bookingRows()).toHaveLength(1);
    expect((await app.page(id)).json).toEqual(NOT_FOUND);
    expect((await app.page(staying)).status).toBe(200);
  });
});

describe("the log (criterion 10)", () => {
  it("never holds a cancel token or a guest's email", () => {
    // Runs last: every booking in this file has been made, and some cancelled, by now.
    expect(tokens.length).toBeGreaterThan(10);
    const log = lines.join("\n");
    for (const token of tokens) expect(log).not.toContain(token);
    expect(log).not.toContain("@guests.example.org");
  });
});
