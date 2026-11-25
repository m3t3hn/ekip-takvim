// Shared by the booking link API tests: people with calendars, and calls to
// the host and visitor routes. Import it after the test file has set the
// environment, as the modules read it on first use. The session cookie is a
// real one, read through the real viewer code; the test file stands in for
// next/headers' cookie jar.
import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { MyBookingLinks } from "@/lib/types";

export type LinkBody = {
  title: string;
  description: string;
  durationMin: number;
  days: number[];
  startMin: number;
  endMin: number;
  bufferMin: number;
  noticeMin: number;
  aheadDays: number;
  maxPerDay: number | null;
  meet: boolean;
  active?: boolean;
};

/** Mondays to Fridays, 10:00 to 12:00, 30 minutes, three days. */
export const LINK: LinkBody = {
  title: "Intro call",
  description: "A first chat",
  durationMin: 30,
  days: [1, 2, 3, 4, 5],
  startMin: 600,
  endMin: 720,
  bufferMin: 0,
  noticeMin: 0,
  aheadDays: 3,
  maxPerDay: null,
  meet: false,
};

export type Answer = { status: number; text: string; json: unknown; headers: Headers };
export type Slot = { start: number; end: number };
export type Page = { title: string; description: string; durationMin: number; hostName: string; slots: Slot[] };
export type Made = { start: number; end: number; title: string; hostName: string; cancelUrl: string };

export const NOT_FOUND = { error: "This booking link doesn't exist or was turned off." };
export const TAKEN = { error: "That time was just taken. Pick another." };
/**
 * The limit per address refused a try: the wait, in whole minutes (run
 * 2026-11-25-ekip-quick-wins-visitor, criterion 7; booking-try-limit.test.ts
 * checks the minutes and Retry-After).
 */
export const TOO_MANY = { error: expect.stringMatching(/^Too many tries\. Try again in \d+ minutes?\.$/) };
/** The link took its 30 bookings in the last hour: its own message, not the visitor's tries (same run, criterion 7). */
export const LINK_FULL = { error: "This booking link is taking no more bookings for now. Try again in an hour." };
export const CANT_BOOK = { error: "This booking link can't take bookings right now." };
export const BOOKING_OFF = { error: "Booking links are off on this server." };

/** Every SHA-256 spelling a hash column could hold. */
export function sha256Forms(token: string): string[] {
  const digest = createHash("sha256").update(token).digest();
  return [digest.toString("hex"), digest.toString("base64"), digest.toString("base64url")];
}

/** A URL token of at least 128 random bits, in base64url. */
export function expectToken(token: string) {
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(16);
}

export async function bookingApp(jar: { session: string | undefined }) {
  const { NextRequest } = await import("next/server");
  const db = await import("@/lib/server/db");
  const secrets = await import("@/lib/server/secrets");
  const sync = await import("@/lib/server/sync");
  const linksRoute = await import("@/app/api/me/booking-links/route");
  const linkRoute = await import("@/app/api/me/booking-links/[id]/route");
  const myCancelRoute = await import("@/app/api/me/bookings/[id]/cancel/route");
  const bookRoute = await import("@/app/api/book/[id]/route");
  const cancelRoute = await import("@/app/api/book/cancel/[token]/route");

  /** Every answer under /api/book/, as text with its headers, for the privacy checks. */
  const visitorAnswers: { text: string }[] = [];
  let n = 0;
  let address = 0;

  async function read(res: Response): Promise<Answer> {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json, headers: res.headers };
  }

  /** An answer under /api/book/: it always carries X-Robots-Tag: noindex. */
  async function visitor(res: Response): Promise<Answer> {
    const a = await read(res);
    expect(a.headers.get("x-robots-tag") ?? "", `X-Robots-Tag on ${a.status} ${a.text}`).toMatch(/noindex/i);
    visitorAnswers.push({ text: `${a.text}\n${JSON.stringify([...a.headers.entries()])}` });
    return a;
  }

  const json = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(url, {
      method,
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...headers },
    });

  /**
   * Someone who signed in with Google. By default their data is ok: a refresh
   * token, and a primary calendar synced just now with `busy` on it. They
   * allowed booking links to add meetings to their Google Calendar (part 2's
   * booking_access) unless `bookingAccess` is false.
   */
  function person(
    name: string,
    opts: {
      zone?: string;
      refreshToken?: boolean;
      calendar?: boolean;
      busy?: { start: number; end: number; title?: string }[];
      email?: string;
      label?: string;
      bookingAccess?: boolean;
    } = {},
  ) {
    n++;
    const user = db.upsertGoogleUser({
      sub: `g-booking-${n}`,
      email: opts.email ?? `person${n}@example.com`,
      name,
      timezone: opts.zone ?? "Europe/Istanbul",
      refreshToken: opts.refreshToken === false ? null : secrets.encrypt(`1//refresh-${n}`),
      calendarAccess: true,
      bookingAccess: opts.bookingAccess ?? true,
    }).user;
    const calendarId = `primary-${n}@example.com`;
    if (opts.calendar !== false) {
      db.syncCalendarList(user.id, [{ id: calendarId, summary: opts.label ?? "Work", access: "events", primary: true }]);
      db.setBusy(
        user.id,
        calendarId,
        (opts.busy ?? []).map((b, i) => ({ ...b, eventId: `e-${n}-${i}` })),
      );
    }
    return { ...user, calendarId };
  }

  const signIn = (userId: string) => {
    jar.session = secrets.sessionValue(db.getUser(userId)!).value;
  };
  const signOut = () => {
    jar.session = undefined;
  };

  // The host's routes.
  const myLinks = async () => read(await linksRoute.GET());
  const createLink = async (body: unknown) => read(await linksRoute.POST(json("http://localhost/api/me/booking-links", "POST", body)));
  const updateLink = async (id: string, body: unknown) =>
    read(await linkRoute.PUT(json(`http://localhost/api/me/booking-links/${id}`, "PUT", body), { params: Promise.resolve({ id }) }));
  const deleteLink = async (id: string) =>
    read(
      await linkRoute.DELETE(new NextRequest(`http://localhost/api/me/booking-links/${id}`, { method: "DELETE" }), {
        params: Promise.resolve({ id }),
      }),
    );
  const cancelMine = async (id: string) =>
    read(
      await myCancelRoute.POST(new NextRequest(`http://localhost/api/me/bookings/${id}/cancel`, { method: "POST" }), {
        params: Promise.resolve({ id }),
      }),
    );

  /** The signed-in person makes a link; its id (from its path). */
  async function newLink(body: Partial<LinkBody> = {}): Promise<string> {
    const title = body.title ?? `${LINK.title} ${++n}`;
    const a = await createLink({ ...LINK, ...body, title });
    expect(a.status, a.text).toBe(200);
    const link = (a.json as MyBookingLinks).links.find((l) => l.title === title)!;
    expect(link.path).toMatch(/^\/book\/[A-Za-z0-9_-]+$/);
    return link.path.slice("/book/".length);
  }

  /** A host with ok data and one link; signs them out again. */
  async function hostWithLink(body: Partial<LinkBody> = {}, opts: Parameters<typeof person>[1] & { name?: string } = {}) {
    const host = person(opts.name ?? `Host ${n + 1}`, opts);
    signIn(host.id);
    const id = await newLink(body);
    signOut();
    return { host, id };
  }

  /** A client address no other try has used. */
  const nextAddress = () => {
    address++;
    return `10.${(address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}`;
  };

  // The visitor's routes. Each try comes from its own address unless one is given.
  const page = async (id: string) =>
    visitor(await bookRoute.GET(new NextRequest(`http://localhost/api/book/${id}`), { params: Promise.resolve({ id }) }));
  const book = async (id: string, body: unknown, headers?: Record<string, string>) =>
    visitor(
      await bookRoute.POST(json(`http://localhost/api/book/${id}`, "POST", body, headers ?? { "cf-connecting-ip": nextAddress() }), {
        params: Promise.resolve({ id }),
      }),
    );
  const cancelInfo = async (token: string) =>
    visitor(await cancelRoute.GET(new NextRequest(`http://localhost/api/book/cancel/${token}`), { params: Promise.resolve({ token }) }));
  const cancel = async (token: string) =>
    visitor(
      await cancelRoute.POST(new NextRequest(`http://localhost/api/book/cancel/${token}`, { method: "POST" }), { params: Promise.resolve({ token }) }),
    );

  const slotsOf = async (id: string) => {
    const a = await page(id);
    expect(a.status, a.text).toBe(200);
    return (a.json as Page).slots;
  };
  const startsOf = async (id: string) => (await slotsOf(id)).map((s) => s.start);

  /** Book a time as a guest; the cancel token. */
  async function bookAs(id: string, start: number, guest = `guest${++n}`): Promise<string> {
    const a = await book(id, { start, name: `Guest ${guest}`, email: `${guest}@guests.example.org`, note: `Note from ${guest}` });
    expect(a.status, a.text).toBe(200);
    return new URL((a.json as Made).cancelUrl).pathname.split("/").pop()!;
  }

  const bookingRows = () => db.db().prepare("SELECT * FROM bookings ORDER BY rowid").all() as Record<string, unknown>[];
  const linkRows = () => db.db().prepare("SELECT * FROM booking_links ORDER BY rowid").all() as Record<string, unknown>[];
  /** Every value stored in every table, as text. */
  const everything = () => {
    const tables = (db.db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    return JSON.stringify(tables.map((t) => db.db().prepare(`SELECT * FROM "${t}"`).all()));
  };

  return {
    NextRequest,
    db,
    secrets,
    sync,
    routes: { linksRoute, linkRoute, myCancelRoute, bookRoute, cancelRoute },
    visitorAnswers,
    nextAddress,
    person,
    signIn,
    signOut,
    myLinks,
    createLink,
    updateLink,
    deleteLink,
    cancelMine,
    newLink,
    hostWithLink,
    page,
    book,
    cancelInfo,
    cancel,
    slotsOf,
    startsOf,
    bookAs,
    bookingRows,
    linkRows,
    everything,
  };
}
