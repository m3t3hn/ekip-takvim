// Shared by the booking tests outside the demo (part 2): hosts whose Google
// account the fake Google knows, and the visitor's answers they look at.
import { expect } from "vitest";
import type { bookingApp, LinkBody, Made } from "./booking-helpers";
import type { Account, Calendar, FakeGoogle } from "./google-fake";

type App = Awaited<ReturnType<typeof bookingApp>>;
type PersonOpts = NonNullable<Parameters<App["person"]>[1]>;
export type GoogleHost = ReturnType<App["person"]> & { account: Account };
export type MadeWithInvite = Made & { invited: boolean };

export const READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const CANT_CANCEL = { error: "Couldn't cancel right now. Try again in a few minutes." };
/** Part 2b: a cancel while the booking's event is being made. */
export const BEING_MADE = { error: "This booking is still being made. Try again in a minute." };

/** Leave the demo: Google sign-in is set up, DEMO_MODE is unset. */
export function withGoogle() {
  delete process.env.DEMO_MODE;
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
}

/** The demo: DEMO_MODE=true, no Google sign-in. */
export function inTheDemo() {
  process.env.DEMO_MODE = "true";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
}

export function googleSide(app: App, fake: FakeGoogle) {
  /** Someone who signed in with Google (see person()), with the account the fake keeps for them. */
  function googleHost(name: string, opts: PersonOpts = {}): GoogleHost {
    const host = app.person(name, opts);
    const account = fake.account({
      refreshToken: app.secrets.decrypt(host.refresh_token!),
      primary: host.calendarId,
      timeZone: host.timezone,
    });
    return { ...host, account };
  }

  /** A Google host with one link; signs them out again. */
  async function hostWithLink(body: Partial<LinkBody> = {}, opts: PersonOpts & { name?: string } = {}) {
    const host = googleHost(opts.name ?? "Ayşe Host", opts);
    app.signIn(host.id);
    const id = await app.newLink(body);
    app.signOut();
    return { host, id };
  }

  /**
   * More Google calendars for a host, in the app (ticked or not, synced just
   * now) and in their Google account's calendar list. The primary stays first.
   */
  function addCalendars(host: GoogleHost, more: { id: string; summary: string; access: "events" | "freebusy"; included: boolean }[]) {
    const list = [
      { id: host.calendarId, summary: "Work", access: "events" as const, primary: true },
      ...more.map((c) => ({ id: c.id, summary: c.summary, access: c.access, primary: false })),
    ];
    app.db.syncCalendarList(host.id, list);
    app.db.updateCalendarChoices(host.id, [
      { id: host.calendarId, label: "Work", included: true },
      ...more.map((c) => ({ id: c.id, label: c.summary, included: c.included })),
    ]);
    for (const c of more) app.db.setBusy(host.id, c.id, []);
    host.account.calendars = list.map(
      (c): Calendar => ({
        id: c.id,
        summary: c.summary,
        accessRole: c.access === "freebusy" ? "freeBusyReader" : c.primary ? "owner" : "reader",
        primary: c.primary,
        timeZone: host.timezone,
      }),
    );
    for (const c of more) if (!fake.events.has(c.id)) fake.events.set(c.id, []);
  }

  /** Book `start` and expect it made; the answer, its cancel token and the stored row. */
  async function bookIt(id: string, start: number, guest: { name: string; email: string; note?: string }) {
    const a = await app.book(id, { start, ...guest });
    expect(a.status, a.text).toBe(200);
    const made = a.json as MadeWithInvite;
    const token = new URL(made.cancelUrl).pathname.split("/").pop()!;
    const row = app.bookingRows().find((r) => r.start_ms === start && r.link_id === id && r.cancelled_at === null)!;
    expect(row, "the stored booking").toBeTruthy();
    return { made, token, row };
  }

  /** Delete an event in Google Calendar, as the host would: Google then answers a get of it with status "cancelled". */
  function deleteInGoogle(calendarId: string, eventId: string) {
    expect(fake.remove(calendarId, eventId), `event ${eventId} on ${calendarId}`).toBe(true);
  }

  /** The event Google holds for a booking. */
  function eventOf(calendarId: string, eventId: unknown) {
    const found = (fake.events.get(calendarId) ?? []).find((e) => e.id === eventId);
    expect(found, `event ${String(eventId)} on ${calendarId}`).toBeTruthy();
    return found!;
  }

  return { googleHost, hostWithLink, addCalendars, bookIt, deleteInGoogle, eventOf };
}
