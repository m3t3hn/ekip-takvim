import { createHash, randomBytes, randomUUID } from "node:crypto";
import { offeredTimes, type BookingRule, type OfferedTimes, type Span } from "@/lib/booking";
import { HOUR, MINUTE, dayKeyOf, dayStart } from "@/lib/time";
import type { BookingLinkFields, MyBookingLink, MyBookingLinks } from "@/lib/types";
import { bookingAllowed } from "./booking-setting";
import {
  busyBetween,
  countsAsBusy,
  db,
  dropEventBusy,
  getUser,
  listCalendars,
  setBookingAccess,
  transaction,
  type UserRow,
} from "./db";
import { GoogleError, accessToken, deleteEvent, dropAccessToken, freeBusy, insertEvent, type EventToMake } from "./google";
import { SlidingLimit } from "./rate-limit";
import { decrypt, isDemo } from "./secrets";
import { accessLost, counted, dataStatus, getConfig, log, refreshTokenRefused, syncOne, syncWindow } from "./sync";

// Booking links: a signed-in person, the host, makes a link and sends it to
// anyone. A visitor opens it without signing in, sees the host's free times
// under the link's rules, and books one with a name and an email. Visitors
// learn nothing about the host but their name and those free times, and which
// of the days the link offers are full. Until its meeting ends, a booking can
// be cancelled with the cancel link the visitor gets, which is the
// confirmation's own address (only its hash is kept), or by the host.
//
// Outside the demo a booking is also an event on the host's primary Google
// calendar, with the visitor invited, which the host allows once on My
// settings (booking_access). Cancelling a booking deletes its event; deleting
// the event in Google Calendar cancels the booking at the next sync (see
// cancelBookingsGone in sync.ts). The demo never calls Google.

/** Booking links one person can have. */
export const MAX_BOOKING_LINKS = 10;

export type BookingLinkRow = {
  id: string;
  user_id: string;
  title: string;
  description: string;
  duration_min: number;
  /** The weekdays it offers, e.g. "1,2,3,4,5" (0 = Sunday). */
  days: string;
  start_min: number;
  end_min: number;
  buffer_min: number;
  notice_min: number;
  ahead_days: number;
  max_per_day: number | null;
  meet: number;
  active: number;
  created_at: number;
};

export type BookingRow = {
  id: string;
  user_id: string;
  /** Null once the link was deleted. */
  link_id: string | null;
  title: string;
  start_ms: number;
  end_ms: number;
  guest_name: string;
  guest_email: string;
  note: string | null;
  cancel_hash: string;
  created_at: number;
  cancelled_at: number | null;
  /** The host's Google event, outside the demo once it's made. */
  event_id: string | null;
  calendar_id: string | null;
  /** When that event was made. */
  event_made_at: number | null;
};

/** 192 random bits, for an address that is its own secret: a booking link, a cancel link. */
function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** How a cancel token is kept: its SHA-256 (hex), so the database never holds the token. */
export function cancelHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function daysOf(text: string): number[] {
  return (text.match(/\d+/g) ?? []).map(Number);
}

function ruleOf(link: BookingLinkRow): BookingRule {
  return {
    durationMin: link.duration_min,
    days: daysOf(link.days),
    startMin: link.start_min,
    endMin: link.end_min,
    bufferMin: link.buffer_min,
    noticeMin: link.notice_min,
    aheadDays: link.ahead_days,
    maxPerDay: link.max_per_day,
  };
}

/** A link's fields as the host sets them, with whether it's on. */
export function linkFields(link: BookingLinkRow): BookingLinkFields & { active: boolean } {
  return {
    title: link.title,
    description: link.description,
    ...ruleOf(link),
    meet: !!link.meet,
    active: !!link.active,
  };
}

function myLink(link: BookingLinkRow): MyBookingLink {
  return { id: link.id, ...linkFields(link), path: `/book/${link.id}` };
}

/** What went wrong with Google, for the log: Google's error, never anything the visitor typed. */
const googleProblem = (err: unknown) => (err instanceof GoogleError ? err.message : "Couldn't reach Google");

/**
 * For the log, when Google said the host's token lacks the permission to add
 * or delete events: what the host has to do, rather than explain()'s advice
 * for reading calendars.
 */
const NO_BOOKING_ACCESS = "Google says the permission to add and delete events is missing: the host has to press Allow access on My settings";

/** Google said the host doesn't allow booked meetings in their Google Calendar (any more). */
const missingPermission = (err: unknown) => err instanceof GoogleError && err.missingPermission;

/** googleProblem, for a call that adds or deletes an event: a missing permission is the host's to allow. */
const writeProblem = (err: unknown) => (missingPermission(err) ? NO_BOOKING_ACCESS : googleProblem(err));

/** Google turned down the access token a Calendar API request used: it answered 401. */
const turnedDown = (err: unknown): err is GoogleError => err instanceof GoogleError && err.signInAgain;

/** A host's Google access for one booking or one cancel (see hostAccess). */
type HostAccess = {
  /** The access token in use: the one kept for the host, or the one a 401 brought. */
  readonly token: string;
  /** `request` with the token in use; after a 401, once more with a new one. */
  call<T>(request: (token: string) => Promise<T>): Promise<T>;
};

/**
 * A host's Google access for one booking or one cancel. Its requests use the
 * access token kept for the host (accessToken), as the sync's do, and a kept
 * token can have gone stale. So when Google answers one of them 401, the kept
 * token is dropped and a new one asked for (accessLost); with it, that request
 * is made once more, and the requests after it use it too. That's once per
 * booking or cancel: a 401 to the new token too fails the request, and that
 * token isn't used again. Only Google refusing the host's refresh token
 * (invalid_grant) marks them as having to sign in again, as in the sync: on
 * the first token request, at once and without asking again, or on the
 * renewal. `sealed` is the host's stored refresh token. Throws what decrypt
 * and accessToken throw.
 */
async function hostAccess(host: UserRow, sealed: string): Promise<HostAccess> {
  const refreshToken = decrypt(sealed);
  let token: string;
  try {
    token = await accessToken(refreshToken);
  } catch (err) {
    // Google refused the refresh token itself: asking again would get the same answer.
    if (err instanceof GoogleError && err.signInAgain) refreshTokenRefused(host, err.message);
    throw err;
  }
  let renewed = false;
  async function call<T>(request: (token: string) => Promise<T>): Promise<T> {
    try {
      return await request(token);
    } catch (err) {
      if (!turnedDown(err)) throw err;
      if (renewed) {
        // Google turned the new token down too: it isn't used again, and nobody is marked.
        dropAccessToken(refreshToken, token);
        throw err;
      }
      renewed = true;
      const next = await accessLost(host, err.message);
      if (!next) throw err;
      token = next;
      return call(request);
    }
  }
  return {
    get token() {
      return token;
    },
    call,
  };
}

// ---------------------------------------------------------------------------
// The host's side, on My settings.

/**
 * Someone's booking links, their bookings that haven't ended or been
 * cancelled, soonest first, and whether they allowed booked meetings in their
 * Google Calendar: without that, their links offer no times.
 */
export function myBookingLinks(userId: string, now = Date.now()): MyBookingLinks {
  const conn = db();
  const links = conn.prepare("SELECT * FROM booking_links WHERE user_id = ? ORDER BY created_at, rowid").all(userId) as BookingLinkRow[];
  const upcoming = conn
    .prepare("SELECT * FROM bookings WHERE user_id = ? AND cancelled_at IS NULL AND end_ms > ? ORDER BY start_ms, created_at")
    .all(userId, now) as BookingRow[];
  return {
    bookingAccess: !!getUser(userId)?.booking_access,
    links: links.map(myLink),
    upcoming: upcoming.map((b) => ({
      id: b.id,
      title: b.title,
      start: b.start_ms,
      end: b.end_ms,
      guestName: b.guest_name,
      guestEmail: b.guest_email,
      note: b.note,
    })),
  };
}

/** One of someone's booking links; null for anyone else's, or an unknown id. */
export function ownLink(userId: string, id: string): BookingLinkRow | null {
  return (db().prepare("SELECT * FROM booking_links WHERE id = ? AND user_id = ?").get(id, userId) as BookingLinkRow | undefined) ?? null;
}

const linkValues = (f: BookingLinkFields) => [
  f.title,
  f.description,
  f.durationMin,
  f.days.join(","),
  f.startMin,
  f.endMin,
  f.bufferMin,
  f.noticeMin,
  f.aheadDays,
  f.maxPerDay,
  f.meet ? 1 : 0,
];

/** Make a booking link, on; null when they already have MAX_BOOKING_LINKS. */
export function addBookingLink(userId: string, fields: BookingLinkFields): string | null {
  const conn = db();
  const { n } = conn.prepare("SELECT COUNT(*) AS n FROM booking_links WHERE user_id = ?").get(userId) as { n: number };
  if (n >= MAX_BOOKING_LINKS) return null;
  const id = newToken();
  conn
    .prepare(
      `INSERT INTO booking_links (title, description, duration_min, days, start_min, end_min, buffer_min, notice_min,
         ahead_days, max_per_day, meet, id, user_id, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(...linkValues(fields), id, userId, Date.now());
  return id;
}

/** Change one of someone's booking links; false when it isn't theirs. */
export function updateBookingLink(userId: string, id: string, fields: BookingLinkFields & { active: boolean }): boolean {
  const changed = db()
    .prepare(
      `UPDATE booking_links SET title = ?, description = ?, duration_min = ?, days = ?, start_min = ?, end_min = ?,
         buffer_min = ?, notice_min = ?, ahead_days = ?, max_per_day = ?, meet = ?, active = ?
       WHERE id = ? AND user_id = ?`,
    )
    .run(...linkValues(fields), fields.active ? 1 : 0, id, userId);
  return Number(changed.changes) > 0;
}

/**
 * Delete one of someone's booking links; false when it isn't theirs. Its
 * bookings stay, and keep blocking the host's times on their other links.
 */
export function deleteBookingLink(userId: string, id: string): boolean {
  const removed = db().prepare("DELETE FROM booking_links WHERE id = ? AND user_id = ?").run(id, userId);
  return Number(removed.changes) > 0;
}

/** One of someone's bookings; null for anyone else's, or an unknown id. */
export function ownBooking(userId: string, id: string): BookingRow | null {
  return (db().prepare("SELECT * FROM bookings WHERE id = ? AND user_id = ?").get(id, userId) as BookingRow | undefined) ?? null;
}

/**
 * How long a booking without an event may still be getting one. Its event is
 * recorded within about 100 seconds, or else the booking is dropped within
 * about 2 minutes: at most six Google calls, each given up after 20 (the
 * token, free/busy and the insert; after a 401, a new token and that request
 * once more; and deleting an event whose insert never answered).
 */
const MAKING_MS = 2 * MINUTE;

/**
 * Whether a booking's event is being made: outside the demo, it has no event
 * yet and was made less than 2 minutes ago. One without an event that's
 * older, such as a hold left by a crash, has none coming.
 */
function beingMade(booking: BookingRow, now: number): boolean {
  return !isDemo() && booking.event_id === null && booking.created_at > now - MAKING_MS;
}

/**
 * What cancelBooking did: cancelled the booking (or found it cancelled
 * already), didn't because its meeting has ended ("ended") or its event is
 * still being made ("being made"), or couldn't delete its event ("failed").
 */
export type CancelResult = "cancelled" | "ended" | "being made" | "failed";

/** Whether a booking's meeting has ended: it took place, and can't be cancelled any more. */
export const hasEnded = (booking: Pick<BookingRow, "end_ms">, now = Date.now()) => booking.end_ms <= now;

/**
 * Cancel a booking, by its cancel link or by its host: its time is free
 * again. Outside the demo its Google event is deleted first, and Google tells
 * the visitor; an event Google says is gone already counts as deleted. When
 * it couldn't be deleted ("failed"), the booking stays as it was. So does one
 * whose meeting has ended ("ended"): it took place, so its event stays in
 * Google Calendar, and Google isn't asked. So does one whose event is still
 * being made ("being made", see beingMade), and Google isn't asked: cancelled
 * now, it would leave the event made a moment later. One cancelled already
 * stays as it was too, and Google isn't asked.
 */
export async function cancelBooking(booking: BookingRow): Promise<CancelResult> {
  if (booking.cancelled_at !== null) return "cancelled";
  const now = Date.now();
  if (hasEnded(booking, now)) return "ended";
  if (beingMade(booking, now)) return "being made";
  const event = booking.event_id && !isDemo() ? { id: booking.event_id, calendarId: booking.calendar_id ?? "primary" } : null;
  if (event && !(await deleteBookingEvent(booking.user_id, event))) return "failed";
  transaction(() => {
    db().prepare("UPDATE bookings SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL").run(Date.now(), booking.id);
    // The event's busy time goes too, if a sync read it already, rather than at the next sync.
    if (event) dropEventBusy(booking.user_id, event.calendarId, event.id);
  });
  return "cancelled";
}

/**
 * Delete a booking's event from its host's Google Calendar; false when that
 * didn't work. A delete Google answers 401 is made once more with a new token
 * (see hostAccess): a 401 deletes nothing. Google saying the permission is
 * missing means the host no longer allows booked meetings: their links offer
 * no times until they press Allow access again.
 */
async function deleteBookingEvent(hostId: string, event: { id: string; calendarId: string }): Promise<boolean> {
  const host = getUser(hostId);
  try {
    if (!host?.refresh_token) throw new GoogleError("No Google access to delete the event with");
    const google = await hostAccess(host, host.refresh_token);
    await google.call((token) => deleteEvent(token, event.calendarId, event.id));
    return true;
  } catch (err) {
    if (missingPermission(err)) setBookingAccess(hostId, false);
    log("warn", "booking event not deleted", { scope: "booking", user: hostId, error: writeProblem(err) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// The visitor's side.

/** A booking link a visitor can open: booking links are on, the link is on, and its host is still here. */
export function openLink(id: string): { link: BookingLinkRow; host: UserRow } | null {
  if (!bookingAllowed()) return null;
  const link = (db().prepare("SELECT * FROM booking_links WHERE id = ?").get(id) as BookingLinkRow | undefined) ?? null;
  if (!link?.active) return null;
  const host = getUser(link.user_id);
  return host ? { link, host } : null;
}

/** At most 30 bookings per hour on one link, from anyone, cancelled ones included. */
const LINK_BOOKINGS_PER_HOUR = 30;

/**
 * Whether a link took 30 bookings in the last hour. They're counted from the
 * stored bookings, cancelled ones included, so a restart doesn't clear them;
 * a booking dropped because it couldn't be completed is deleted, so it doesn't
 * count. Once the oldest of them is an hour old, the link takes bookings again.
 */
function linkFull(link: BookingLinkRow, now: number): boolean {
  const { n } = db()
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE link_id = ? AND created_at > ?")
    .get(link.id, now - HOUR) as { n: number };
  return n >= LINK_BOOKINGS_PER_HOUR;
}

/**
 * The times a link offers at `now`, as its page shows them. They come from
 * the host's busy blocks, counted as /api/availability counts them (calendar
 * links included), and all their active bookings, on the host's clock, up to
 * the end of the synced days. None, in the demo too, while the host hasn't
 * allowed booked meetings in their Google Calendar or the link is full (30
 * bookings in the last hour); none while the host's data can't be trusted.
 */
export function freeTimes(link: BookingLinkRow, host: UserRow, now = Date.now()): Span[] {
  return linkTimes(link, host, now).slots;
}

/** No times and no full days, as a new value each time, so nobody shares it. */
const nothing = (): OfferedTimes => ({ slots: [], full: [] });

/**
 * freeTimes, with the days the link offers that are full (see offeredTimes).
 * With no free time at all, no full days either: the page then only says
 * there are no free times, so it can't tell a host who's busy every day from
 * one whose link offers nothing for another reason.
 */
export function linkTimes(link: BookingLinkRow, host: UserRow, now = Date.now()): OfferedTimes {
  if (!host.booking_access || linkFull(link, now)) return nothing();
  const config = getConfig();
  if (!config) return nothing();
  if (dataStatus(host, listCalendars(host.id).filter(countsAsBusy), now, isDemo()) !== "ok") return nothing();
  const until = syncWindow(config).to.getTime();
  // From the start of the host's day: a booking earlier today counts toward the
  // day's cap. A buffer is at most half an hour.
  const from = dayStart(dayKeyOf(now, host.timezone), host.timezone) - HOUR;
  const busy = busyBetween(from, until + HOUR, host.id).map((b) => ({ start: b.start_ms, end: b.end_ms }));
  const booked = (
    db()
      .prepare("SELECT start_ms, end_ms, link_id FROM bookings WHERE user_id = ? AND cancelled_at IS NULL AND end_ms > ?")
      .all(host.id, from) as Pick<BookingRow, "start_ms" | "end_ms" | "link_id">[]
  ).map((b) => ({ start: b.start_ms, end: b.end_ms, here: b.link_id === link.id }));
  const times = offeredTimes({ rule: ruleOf(link), zone: host.timezone, now, until, busy, booked });
  return times.slots.length ? times : nothing();
}

export type Guest = { name: string; email: string; note: string | null };

/**
 * What bookTime did: booked the time, or didn't because the link took 30
 * bookings in the last hour ("link full") or doesn't offer that time right
 * now ("not offered").
 */
export type BookTimeResult =
  | { outcome: "booked"; booking: BookingRow; token: string }
  | { outcome: "link full" }
  | { outcome: "not offered" };

/**
 * Book the time starting at `start`, if the link offers it right now and took
 * fewer than 30 bookings in the last hour (see linkFull). The count, the check
 * and the insert are one synchronous step, with nothing awaited between them,
 * so two requests for one time can't both get it, and requests sent together
 * can't take a link past 30. Outside the demo the booking then holds the time
 * while its Google event is made (createBookingEvent). A booking comes with its
 * cancel token, which is kept only as its hash.
 */
export function bookTime(
  link: BookingLinkRow,
  host: UserRow,
  guest: Guest,
  start: number,
  now = Date.now(),
): BookTimeResult {
  if (linkFull(link, now)) return { outcome: "link full" };
  const slot = freeTimes(link, host, now).find((s) => s.start === start);
  if (!slot) return { outcome: "not offered" };
  const token = newToken();
  const booking: BookingRow = {
    id: randomUUID(),
    user_id: host.id,
    link_id: link.id,
    title: link.title,
    start_ms: slot.start,
    end_ms: slot.end,
    guest_name: guest.name,
    guest_email: guest.email,
    note: guest.note,
    cancel_hash: cancelHash(token),
    created_at: now,
    cancelled_at: null,
    event_id: null,
    calendar_id: null,
    event_made_at: null,
  };
  db()
    .prepare(
      `INSERT INTO bookings (id, user_id, link_id, title, start_ms, end_ms, guest_name, guest_email, note, cancel_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      booking.id,
      booking.user_id,
      booking.link_id,
      booking.title,
      booking.start_ms,
      booking.end_ms,
      booking.guest_name,
      booking.guest_email,
      booking.note,
      booking.cancel_hash,
      booking.created_at,
    );
  return { outcome: "booked", booking, token };
}

/** Take back a booking that couldn't be completed: nothing of it is kept. */
export function dropBooking(id: string): void {
  db().prepare("DELETE FROM bookings WHERE id = ?").run(id);
}

/** A booking just stored, with its link and host: what its event needs. */
export type NewBooking = { booking: BookingRow; host: UserRow; link: BookingLinkRow };

/**
 * What createBookingEvent did: made the event, found the time taken in Google
 * ("busy"), or couldn't ask Google or was refused ("failed"). Only a booking
 * whose event was made is kept.
 */
export type BookingEvent = "made" | "busy" | "failed";

/** Text for HTML: &, < and > escaped. */
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A visitor's name on one line: each run of whitespace in it is one space. */
const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * A booked meeting's event description, in HTML: the link's description, the
 * visitor's note under "Note from <name>:", and where it was booked. Every
 * line of text is escaped, and the lines are joined with <br>.
 */
function eventDescription(description: string, name: string, note: string | null): string {
  const lines = (text: string) => text.split(/\r\n|\r|\n/);
  return [...(description ? lines(description) : []), ...(note ? [`Note from ${name}:`, ...lines(note)] : []), "Booked through Ekip Takvim."]
    .map(escapeHtml)
    .join("<br>");
}

/**
 * Outside the demo a booking is also an event on the host's primary Google
 * calendar, with the visitor invited. While the booking holds the time (see
 * bookTime), this asks Google live whether the host's counted Google
 * calendars are free over the time and its breaks, makes the event, and
 * records it on the booking: its id, its calendar, and when it was made.
 *
 * The event's title is the link's title with the visitor's name. Its
 * description is the link's description, the visitor's note and where it was
 * booked, but never the cancel link: colleagues who can see the host's event
 * details would see it, and the sync would store it.
 *
 * The event is made under its own id, the booking's without its dashes, and
 * recorded only on a booking that's still active. When the booking was
 * cancelled, or its host removed themselves, while Google made the event, the
 * event is deleted again ("failed"). So is one an insert may have made without
 * saying so: it timed out, couldn't reach Google, or Google answered 5xx. A
 * 4xx answer made none.
 *
 * Its Google requests use the host's kept access token, as the sync's do, and
 * one Google answers 401 is made once more with a new token (see hostAccess):
 * a kept token can have gone stale. An insert answered 401 made nothing, so
 * it's made again under the same id. Only a refresh token Google refuses means
 * the host has to sign in again, as in the sync; a 403 on the insert saying
 * the permission is missing, that they no longer allow it. Each failure is one
 * warning in the log, with the host's id and Google's error, never the
 * visitor's name, email or note.
 */
export async function createBookingEvent({ booking, host, link }: NewBooking): Promise<BookingEvent> {
  // 32 hex characters, which Google takes as an event id.
  const eventId = booking.id.replace(/-/g, "");
  let step: "token" | "free/busy" | "insert" = "token";
  let google: HostAccess | null = null;
  let made: { id: string; organizer: string | null } | null = null;
  try {
    if (!host.refresh_token) throw new GoogleError("No Google access to make the event with");
    google = await hostAccess(host, host.refresh_token);

    step = "free/busy";
    const from = booking.start_ms - link.buffer_min * MINUTE;
    const to = booking.end_ms + link.buffer_min * MINUTE;
    const calendars = counted(host, listCalendars(host.id).filter(countsAsBusy)).google;
    // One check of them all: after a 401 to any of them, each is asked again with the new token.
    const busy = await google.call((token) =>
      Promise.all(calendars.map((c) => freeBusy(token, c.calendar_id, new Date(from), new Date(to)))),
    );
    // A busy time that only touches the range doesn't take it, as with the times offered.
    if (busy.flat().some((b) => b.start < to && b.end > from)) return "busy";

    step = "insert";
    const name = oneLine(booking.guest_name);
    const event: EventToMake = {
      id: eventId,
      summary: `${booking.title} (${name})`,
      description: eventDescription(link.description, name, booking.note),
      start: booking.start_ms,
      end: booking.end_ms,
      timeZone: host.timezone,
      guest: { email: booking.guest_email, displayName: name },
      meetRequestId: link.meet ? booking.id : null,
    };
    made = await google.call((token) => insertEvent(token, event));
    // The primary calendar as the sync knows it, so its reads can tell when the event is deleted.
    const primary = listCalendars(host.id).find((c) => c.kind === "google" && c.is_primary)?.calendar_id;
    const recorded = db()
      .prepare("UPDATE bookings SET event_id = ?, calendar_id = ?, event_made_at = ? WHERE id = ? AND cancelled_at IS NULL")
      .run(made.id, primary ?? made.organizer ?? "primary", Date.now(), booking.id);
    if (Number(recorded.changes) > 0) return "made";
    // The booking is gone, or was cancelled: its event goes too.
    log("info", "booking gone while its event was made: the event is deleted again", { scope: "booking", user: host.id, event: made.id });
    await deleteMadeEvent(host.id, google.token, made.id);
    return "failed";
  } catch (err) {
    if (step === "insert" && missingPermission(err)) setBookingAccess(host.id, false);
    const error = step === "insert" ? writeProblem(err) : googleProblem(err);
    log("warn", "booking event not made", { scope: "booking", user: host.id, step, error });
    if (step === "insert" && google) {
      // The event made, or one Google may have made without saying so, goes again, with the token
      // the last insert used. A 4xx answer made none.
      const left = made?.id ?? (answeredClientError(err) ? null : eventId);
      if (left) await deleteMadeEvent(host.id, google.token, left);
    }
    return "failed";
  }
}

/** Google answered with a 4xx: it did nothing, rather than may have done something. */
const answeredClientError = (err: unknown) => err instanceof GoogleError && err.status !== undefined && err.status >= 400 && err.status < 500;

/**
 * Delete an event from the host's primary calendar again, with Google telling
 * the visitor: one made for a booking that's gone, or one an insert may have
 * made without saying so. Best effort: one that's gone, or was never made,
 * counts as deleted, and any other failure is one warning in the log, with
 * the host's id and the event's id.
 */
async function deleteMadeEvent(hostId: string, token: string, eventId: string): Promise<void> {
  try {
    await deleteEvent(token, "primary", eventId);
  } catch (err) {
    log("warn", "booking event may be left in Google", { scope: "booking", user: hostId, event: eventId, error: writeProblem(err) });
  }
}

/**
 * Where a visitor can book another time instead of a booking: its link's
 * page, "/book/<id>", while that link is one a visitor can open (see
 * openLink); null once it was deleted or turned off, or its host left.
 */
export function bookAgainPath(booking: Pick<BookingRow, "link_id">): string | null {
  return booking.link_id && openLink(booking.link_id) ? `/book/${booking.link_id}` : null;
}

/** The booking a cancel token is for, with its host's name; null for any other token. */
export function bookingByToken(token: string): (BookingRow & { host_name: string }) | null {
  if (!bookingAllowed() || !token) return null;
  return (
    (db()
      .prepare("SELECT b.*, u.name AS host_name FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.cancel_hash = ?")
      .get(cancelHash(token)) as (BookingRow & { host_name: string }) | undefined) ?? null
  );
}

// ---------------------------------------------------------------------------
// What's counted in memory, so a restart clears it: the rate limit on booking
// tries per client address, and when each host's calendars were last read
// again because Google said an offered time is busy. It lives on the
// process-wide global, like the sync state. A link's own limit counts its
// bookings instead (see linkFull).

type Limits = {
  perAddress: SlidingLimit;
  /** When syncAfterBusy last started a sync, per host. */
  busySyncs?: Map<string, number>;
};
const KEY = Symbol.for("ekip-takvim.booking-limits");
const g = globalThis as typeof globalThis & { [KEY]?: Limits };

/** At most 5 tries per 10 minutes from one address. */
const PER_ADDRESS = { limit: 5, windowMs: 10 * MINUTE };

const limits = () => (g[KEY] ??= { perAddress: new SlidingLimit(PER_ADDRESS.limit, PER_ADDRESS.windowMs) });

/**
 * Whether a try to book from `address` may go ahead. Every try counts,
 * whatever it answers and whichever link it's for, even one this limit
 * refuses. The address comes from the request, so only its first 64
 * characters are kept: an address is at most 45.
 */
export function takeAddressTry(address: string, now = Date.now()): boolean {
  return limits().perAddress.hit(address.slice(0, 64), now);
}

/**
 * How long until a try from `address` may go ahead, in ms: 0 when one may
 * now. Nothing is counted. A limiter an older bookings.ts made (the module was
 * reloaded in development) can't say, so then the whole 10 minutes, which is
 * never shorter than the real wait.
 */
export function addressWait(address: string, now = Date.now()): number {
  const perAddress = limits().perAddress;
  if (typeof perAddress.wait !== "function") return PER_ADDRESS.windowMs;
  return perAddress.wait(address.slice(0, 64), now);
}

/** At most one sync a minute per host, from syncAfterBusy. */
const BUSY_SYNC_EVERY_MS = MINUTE;

/**
 * Google said a time the host's links offered is busy: an event the last sync
 * didn't see. Read the host's calendars again (syncOne), so their links soon
 * stop offering that time, at most once a minute per host. It runs in the
 * background: the visitor's answer doesn't wait for it. Returns that sync, or
 * null when one started for this host less than a minute ago.
 */
export function syncAfterBusy(hostId: string, now = Date.now()): Promise<void> | null {
  const started = (limits().busySyncs ??= new Map());
  const last = started.get(hostId);
  if (last !== undefined && now - last < BUSY_SYNC_EVERY_MS) return null;
  started.set(hostId, now);
  return syncOne(hostId).catch((err) => log("error", "user sync crashed", { user: hostId, error: String(err) }));
}
