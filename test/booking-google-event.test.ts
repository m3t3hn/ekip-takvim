import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { at } from "./booking-reference";
import { CANT_BOOK, TAKEN, bookingApp } from "./booking-helpers";
import { CANT_CANCEL, googleSide, withGoogle } from "./booking-google-helpers";
import { failures, fakeGoogle, shortTimeouts, waitFor, type Call, type Outcome } from "./google-fake";
import { calendarServer, calendarText, captureConsole, vevent } from "./link-helpers";

// Booking links, part 2 (run 2026-11-19-ekip-booking-2): a booking outside
// the demo, through POST /api/book/[id], with Google behind a stubbed fetch.
// - Criterion 4: the live free/busy check, then the host's event.
// - Criterion 5: Google failing at each step.
// - Criterion 9: what visitors never get, and the cancel link never reaching Google.
// "Outside the demo" is Google sign-in set up and DEMO_MODE unset.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const CONFIG = "timezone: UTC\nhorizon_days: 30\n";
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "g".repeat(40);
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

const IST = "Europe/Istanbul";
/** 2026-11-<d> at hh:mm in Istanbul (UTC+3). 2026-11-18 is a Wednesday. */
const ist = (d: number, h: number, m = 0) => at(IST, 2026, 11, d, h, m);
const NOW = ist(18, 9);
const MIN = 60_000;

const setNow = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};

/** The visitor of most tests. Their name, email and note never reach a log line. */
const VISITOR = { name: "Zelda Quibble", email: "zelda.quibble@guests.example.org", note: "Secret note 4471: bring the plans" };
const NEVER_LOGGED = ["Quibble", "zelda.quibble", "Secret note 4471", "Lovelace", "ada.lovelace", "welcome"];

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
});
afterEach(() => {
  timeouts?.mockRestore();
  timeouts = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
  process.env.CONFIG_YAML = CONFIG;
  withGoogle();
  expect(fake.problems).toEqual([]);
  // Criterion 5: no log line holds a visitor's name, email or note.
  const log = lines.join("\n");
  for (const bit of NEVER_LOGGED) expect(log, `the log holds "${bit}"`).not.toContain(bit);
});

/** The free/busy checks made, one entry per calendar asked about. */
function freeBusyChecks(calls: Call[]) {
  return calls.flatMap((c) =>
    ((c.json?.items ?? []) as { id: string }[]).map((item) => ({
      id: item.id,
      from: Date.parse(String(c.json?.timeMin)),
      to: Date.parse(String(c.json?.timeMax)),
      call: c,
    })),
  );
}

describe("a booking outside the demo (criterion 4)", () => {
  it("checks free/busy on each counted Google calendar, then makes one event on the host's primary calendar, stores it and answers invited: true", async () => {
    const host = google.googleHost("Ayşe Host", { email: "ayse.host@example.com" });
    const P = host.calendarId;
    const team = "team-shared@group.calendar.google.com";
    const boss = "boss.freebusy@example.com";
    const holidays = "tr.turkish#holiday@group.v.calendar.google.com";
    google.addCalendars(host, [
      { id: team, summary: "Team", access: "events", included: true },
      { id: boss, summary: "Boss", access: "freebusy", included: true },
      { id: holidays, summary: "Holidays", access: "events", included: false },
    ]);
    // A calendar link counts too, but it isn't Google's to check.
    const side = db.addLinkCalendar(host.id, "https://ics.example.net/private/k3y/basic.ics", "Side job");
    db.setBusy(host.id, side, []);
    app.signIn(host.id);
    const title = `Q&A <intro> "call"`;
    const id = await app.newLink({
      title,
      description: "Bring your portfolio & questions.\n<b>Not</b> bold > plain",
      bufferMin: 15,
      meet: true,
    });
    app.signOut();
    const start = ist(19, 10, 30);
    expect(await app.startsOf(id)).toContain(start);

    const a = await app.book(id, {
      start,
      name: "Ada  <Lovelace>\t&\nCo",
      email: "ada.lovelace@guests.example.org",
      note: "Hi & <welcome>\nSecond line > first",
    });
    expect(a.status, a.text).toBe(200);
    const made = a.json as Record<string, unknown>;
    expect(Object.keys(made).sort()).toEqual(["cancelUrl", "end", "hostName", "invited", "start", "title"]);
    expect(made).toMatchObject({ start, end: start + 30 * MIN, title, hostName: "Ayşe Host", invited: true });
    expect(String(made.cancelUrl)).toMatch(/^https:\/\/cal\.example\.com\/book\/cancel\/[A-Za-z0-9_-]+$/);

    // The live check: each counted Google calendar, over the time and its buffer.
    const checks = freeBusyChecks(fake.of("freeBusy"));
    expect(checks.map((c) => c.id).sort()).toEqual([P, team, boss].sort());
    for (const c of checks) {
      expect([c.id, c.from, c.to]).toEqual([c.id, start - 15 * MIN, start + 45 * MIN]);
      expect(c.call.account, "with the host's token").toBe(host.account);
    }

    // Then one event, on the host's primary calendar, with the visitor invited.
    const inserts = fake.of("insert");
    expect(inserts).toHaveLength(1);
    const insert = inserts[0];
    for (const c of checks) expect(fake.calls.indexOf(c.call)).toBeLessThan(fake.calls.indexOf(insert));
    expect(insert.account, "with the host's token").toBe(host.account);
    expect(insert.url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(insert.url.searchParams.get("sendUpdates")).toBe("all");
    expect(insert.url.searchParams.get("conferenceDataVersion")).toBe("1");

    const event = insert.json!;
    expect(event.summary).toBe(`Q&A <intro> "call" (Ada <Lovelace> & Co)`);
    expect(event.description).toBe(
      [
        "Bring your portfolio &amp; questions.",
        "&lt;b&gt;Not&lt;/b&gt; bold &gt; plain",
        "Note from Ada &lt;Lovelace&gt; &amp; Co:",
        "Hi &amp; &lt;welcome&gt;",
        "Second line &gt; first",
        "Booked through Ekip Takvim.",
      ].join("<br>"),
    );
    const when = (t: unknown) => t as { dateTime: string; timeZone?: string };
    expect(Date.parse(when(event.start).dateTime)).toBe(start);
    expect(Date.parse(when(event.end).dateTime)).toBe(start + 30 * MIN);
    expect([when(event.start).timeZone, when(event.end).timeZone], "the host's zone").toEqual([IST, IST]);
    expect(event.attendees).toEqual([{ email: "ada.lovelace@guests.example.org", displayName: "Ada <Lovelace> & Co" }]);

    // Stored: Google's event id and the calendar it's on.
    const rows = app.bookingRows();
    expect(rows).toHaveLength(1);
    const madeEvents = fake.events.get(P)!;
    expect(madeEvents).toHaveLength(1);
    expect(rows[0]).toMatchObject({ start_ms: start, cancelled_at: null, event_id: madeEvents[0].id, calendar_id: P });
    expect((event.conferenceData as { createRequest?: unknown }).createRequest).toEqual({
      requestId: rows[0].id,
      conferenceSolutionKey: { type: "hangoutsMeet" },
    });

    // The cancel link stays out of Google.
    const token = String(made.cancelUrl).split("/").pop()!;
    for (const c of fake.calls) {
      expect(c.url.href).not.toContain(token);
      expect(c.body).not.toContain(token);
      expect(c.body).not.toContain("/book/cancel");
    }
    expect(await app.startsOf(id)).not.toContain(start);
  });

  it.each([
    ["no description and no note", "", undefined, ["Booked through Ekip Takvim."]],
    ["a description and no note", "Line one\nLine two & more", undefined, ["Line one", "Line two &amp; more", "Booked through Ekip Takvim."]],
    ["a note and no description", "", "Hello\nthere", ["Note from Bo Tester:", "Hello", "there", "Booked through Ekip Takvim."]],
  ])("without Meet, asks for no conference, and with %s writes only those lines", async (_what, description, note, expected) => {
    const { id } = await google.hostWithLink({ title: "Plain call", description, meet: false });
    const start = ist(19, 11);
    const a = await app.book(id, { start, name: "Bo   Tester", email: "bo.tester@guests.example.org", ...(note ? { note } : {}) });
    expect(a.status, a.text).toBe(200);
    expect(a.json).toMatchObject({ invited: true });
    const inserts = fake.of("insert");
    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    expect(insert.url.searchParams.get("sendUpdates")).toBe("all");
    expect(insert.url.searchParams.has("conferenceDataVersion")).toBe(false);
    expect(insert.json!.conferenceData).toBeUndefined();
    expect(insert.json!.summary).toBe("Plain call (Bo Tester)");
    expect(insert.json!.description).toBe(expected.join("<br>"));
    expect(insert.json!.attendees).toEqual([{ email: "bo.tester@guests.example.org", displayName: "Bo Tester" }]);
  });

  it("stores the event's organizer as its calendar when the app knows no primary calendar of the host, and checks no Google calendar", async () => {
    // Someone who counts only a calendar link: no Google calendar in the app.
    const host = google.googleHost("Link Host", { calendar: false });
    const side = db.addLinkCalendar(host.id, "https://ics.example.net/private/l1nk/basic.ics", "Side job");
    db.setBusy(host.id, side, []);
    host.account.primary = "organizer.address@example.com";
    app.signIn(host.id);
    const id = await app.newLink({ title: "Link call" });
    app.signOut();
    const start = ist(19, 11);
    expect(await app.startsOf(id)).toContain(start);
    const a = await app.book(id, { start, ...VISITOR });
    expect(a.status, a.text).toBe(200);
    expect(fake.of("freeBusy")).toEqual([]);
    expect(fake.of("insert")).toHaveLength(1);
    const [row] = app.bookingRows();
    expect(row).toMatchObject({ event_id: fake.made[0], calendar_id: "organizer.address@example.com" });
  });

  it("answers 409 for a time the live check finds busy, on any counted calendar or in the buffer, and stores nothing and makes no event", async () => {
    const start = ist(19, 10, 30);
    const end = start + 30 * MIN;
    const cases: [string, "primary" | "team" | "boss", { start: number; end: number }][] = [
      ["the meeting, on the primary calendar", "primary", { start: start + 7 * MIN, end: start + 13 * MIN }],
      ["the meeting, on another counted calendar", "team", { start: start - 60 * MIN, end: start + 1 * MIN }],
      ["the meeting, on a free/busy-only calendar", "boss", { start: end - 1 * MIN, end: end + 60 * MIN }],
      ["the buffer before it", "primary", { start: start - 14 * MIN, end: start - 9 * MIN }],
      ["the buffer after it", "team", { start: end + 11 * MIN, end: end + 14 * MIN }],
    ];
    for (const [what, where, busy] of cases) {
      db.resetAll();
      fake.reset();
      const host = google.googleHost("Busy Host");
      const ids = { primary: host.calendarId, team: `team-${host.id}@group.calendar.google.com`, boss: `boss-${host.id}@example.com` };
      google.addCalendars(host, [
        { id: ids.team, summary: "Team", access: "events", included: true },
        { id: ids.boss, summary: "Boss", access: "freebusy", included: true },
      ]);
      app.signIn(host.id);
      const id = await app.newLink({ bufferMin: 15 });
      app.signOut();
      expect(await app.startsOf(id), what).toContain(start);
      // Google knows of something the last sync didn't see.
      fake.busy.set(ids[where], [busy]);
      const a = await app.book(id, { start, ...VISITOR });
      expect([a.status, a.json], what).toEqual([409, TAKEN]);
      // Part 2b: the 409 starts a sync of the host in the background; let it end before the next case.
      await fake.idle();
      expect(app.bookingRows(), what).toEqual([]);
      expect(fake.of("freeBusy").length, what).toBeGreaterThan(0);
      expect(fake.of("insert"), what).toEqual([]);
      // Nothing of the busy time reaches the visitor.
      for (const t of [busy.start, busy.end]) {
        expect(a.text).not.toContain(String(t));
        expect(a.text).not.toContain(new Date(t).toISOString().slice(0, 16));
      }
    }
  });
});

describe("Google failing while a booking is made (criterion 5)", () => {
  type Step = "token" | "freeBusy" | "insert";
  type After = "offered again" | "signs the host out" | "takes booking access";
  const STEPS: Step[] = ["token", "freeBusy", "insert"];
  const answers: Record<string, (step: Step) => Outcome> = {
    "500": (step) => (step === "token" ? failures.tokenServerError() : failures.serverError()),
    "a timeout": () => "timeout",
    "401": (step) => (step === "token" ? failures.tokenUnauthorized() : failures.unauthorized()),
    "403": (step) => (step === "token" ? failures.tokenForbidden() : failures.forbidden()),
  };
  // What becomes of the host, by criterion 5, and so of their times, by criterion 3:
  // after a 403 on the insert they have no booking access, and they offer no
  // times. Changed in run 2026-11-21-ekip-booking-tokens: an API request answered
  // 401 is made once more with a new token, and failures.unauthorized answers
  // that one 401 too, which fails the booking and marks nobody, so the host's
  // time is offered again. Only a refused refresh token signs the host out.
  const rows: [Step, string, After][] = [
    ["token", "500", "offered again"],
    ["token", "a timeout", "offered again"],
    ["token", "401", "offered again"],
    ["token", "403", "offered again"],
    ["freeBusy", "500", "offered again"],
    ["freeBusy", "a timeout", "offered again"],
    ["freeBusy", "401", "offered again"],
    ["freeBusy", "403", "offered again"],
    ["insert", "500", "offered again"],
    ["insert", "a timeout", "offered again"],
    ["insert", "401", "offered again"],
    ["insert", "403", "takes booking access"],
  ];

  async function failOnce(step: Step, answer: () => Outcome, after: After, link: { meet?: boolean } = {}) {
    const { host, id } = await google.hostWithLink({ meet: true, ...link });
    const start = ist(19, 10, 30);
    expect(await app.startsOf(id)).toContain(start);
    fake.answer[step] = answer;
    const a = await app.book(id, { start, ...VISITOR });
    expect([a.status, a.json]).toEqual([503, CANT_BOOK]);
    // Nothing kept: no booking row, nothing of the visitor anywhere.
    expect(app.bookingRows()).toEqual([]);
    const stored = app.everything();
    for (const bit of [VISITOR.name, VISITOR.email, VISITOR.note]) expect(stored).not.toContain(bit);
    // The failed step was tried; nothing after it was.
    expect(fake.of(step).length).toBeGreaterThan(0);
    for (const later of STEPS.slice(STEPS.indexOf(step) + 1)) expect(fake.of(later), later).toEqual([]);
    // No event is left in Google.
    expect(fake.events.get(host.calendarId)).toEqual([]);

    const user = db.getUser(host.id)!;
    expect(user.token_error !== null, "token_error set").toBe(after === "signs the host out");
    expect(user.booking_access, "booking_access").toBe(after === "takes booking access" ? 0 : 1);
    delete fake.answer[step];
    timeouts?.mockRestore();
    timeouts = null;
    if (after === "offered again") {
      expect(await app.startsOf(id)).toContain(start);
      // And it books once Google answers.
      const again = await app.book(id, { start, ...VISITOR });
      expect(again.status, again.text).toBe(200);
      expect(again.json).toMatchObject({ invited: true });
    } else {
      expect(await app.startsOf(id)).toEqual([]);
    }
  }

  it.each(rows)("%s answering %s: 503, nothing kept, and the host's time %s", async (step, failure, after) => {
    if (failure === "a timeout") timeouts = shortTimeouts(30);
    await failOnce(step, () => answers[failure](step), after);
    if (failure === "a timeout") {
      // It gave up on its own: Google never answered.
      expect(fake.of(step).every((c) => c.signal !== null)).toBe(true);
    }
  });

  it("marks the host as having to sign in again when the token endpoint refuses the refresh token (invalid_grant)", async () => {
    await failOnce("token", failures.invalidGrant, "signs the host out");
  });

  it("keeps booking access after a 403 on the insert that's Google's rate limit", async () => {
    await failOnce("insert", failures.rateLimited, "offered again");
  });

  it("answers 503 when Google can't be reached, or can't say whether a calendar is free", async () => {
    await failOnce("freeBusy", () => "network", "offered again");
    db.resetAll();
    fake.reset();
    await failOnce(
      "freeBusy",
      () =>
        new Response(
          JSON.stringify({ kind: "calendar#freeBusy", calendars: { [fake.accounts[0].primary]: { errors: [{ domain: "global", reason: "backendError" }], busy: [] } } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      "offered again",
    );
  });

  it("answers 503 without Meet too, and keeps no row of the failed try", async () => {
    await failOnce("insert", failures.serverError, "offered again", { meet: false });
    // failOnce booked once after the failure: one row, from the booking that worked.
    expect(app.bookingRows()).toHaveLength(1);
    expect(fake.of("insert").every((c) => !c.url.searchParams.has("conferenceDataVersion"))).toBe(true);
  });
});

describe("what visitors never get, outside the demo (criterion 9)", () => {
  it("keeps the host's email, labels, event titles, busy times, other visitors, event ids and Google tokens out of every answer under /api/book/", async () => {
    const busy = [
      { start: ist(18, 10, 7), end: ist(18, 10, 22), title: "Secret Standup" },
      { start: ist(19, 13, 11), end: ist(19, 14, 49), title: "Secret Lunch" },
    ];
    const host = google.googleHost("Privacy Host", { email: "privacy.host@example.com", label: "Secret Calendar Label", busy });
    // Part 2b: the 409 below starts a sync of this host, which reads Google and
    // the calendar link again. So Google holds the busy events, and the link is
    // served from 127.0.0.1 with its event, rather than looked up on the network.
    fake.events.set(
      host.calendarId,
      busy.map((b, i) => ({
        id: `secret${i}a`,
        status: "confirmed",
        summary: b.title,
        start: { dateTime: new Date(b.start).toISOString() },
        end: { dateTime: new Date(b.end).toISOString() },
      })),
    );
    const server = await calendarServer();
    onTestFinished(() => server.close());
    const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    server.handle((_req, res) => {
      res.setHeader("Content-Type", "text/calendar");
      res.end(calendarText(vevent("l1", "Secret Link Event", `DTSTART:${stamp(ist(20, 10, 41))}`, `DTEND:${stamp(ist(20, 10, 43))}`)));
    });
    const linkCal = db.addLinkCalendar(host.id, `${server.origin}/private/zz9/basic.ics`, "Secret Link Label");
    db.setBusy(host.id, linkCal, [{ start: ist(20, 10, 41), end: ist(20, 10, 43), title: "Secret Link Event", eventId: "l1" }]);
    app.signIn(host.id);
    const id = await app.newLink({ title: "Open hours", description: "Ask me anything", meet: true });
    const other = await app.newLink({ title: "Other hours" });
    app.signOut();
    // Google knows of a busy time the last sync didn't see.
    const live = { start: ist(19, 11, 3), end: ist(19, 11, 17) };
    fake.busy.set(host.calendarId, [live]);

    const answers: { text: string; own: string | null }[] = [];
    const keep = async <T>(own: string | null, call: Promise<T>): Promise<T> => {
      const out = await call;
      answers.push({ text: app.visitorAnswers.at(-1)!.text, own });
      return out;
    };
    const guest = (g: string) => ({ name: `Guest ${g}`, email: `${g}@guests.example.org`, note: `Note of ${g}` });
    const tokenOf = (a: { json: unknown }) => String((a.json as { cancelUrl: string }).cancelUrl).split("/").pop()!;

    await keep(null, app.page(id));
    await keep(null, app.page(other));
    const first = await keep("firstguest", app.book(id, { start: ist(18, 11), ...guest("firstguest") }));
    expect(first.status, first.text).toBe(200);
    const second = await keep("secondguest", app.book(other, { start: ist(19, 10), ...guest("secondguest") }));
    expect(second.status, second.text).toBe(200);
    const taken = await keep("thirdguest", app.book(id, { start: ist(19, 11), ...guest("thirdguest") }));
    expect([taken.status, taken.json]).toEqual([409, TAKEN]);
    // Part 2b: wait for the sync that 409 started, Google and the link, from 127.0.0.1.
    const linkRead = () => db.listCalendars(host.id).find((c) => c.calendar_id === linkCal)!;
    await waitFor(() => linkRead().link_full_read !== null || linkRead().error !== null, "the link to be read again");
    await fake.idle();
    expect(server.hits.map((h) => h.url)).toEqual(["/private/zz9/basic.ics"]);
    expect(linkRead().error).toBeNull();
    fake.answer.insert = failures.serverError;
    const failed = await keep("fourthguest", app.book(id, { start: ist(20, 10), ...guest("fourthguest") }));
    expect([failed.status, failed.json]).toEqual([503, CANT_BOOK]);
    delete fake.answer.insert;
    await keep(null, app.page(id));
    await keep("firstguest", app.cancelInfo(tokenOf(first)));
    await keep("secondguest", app.cancelInfo(tokenOf(second)));
    fake.answer.delete = failures.serverError;
    const notYet = await keep("firstguest", app.cancel(tokenOf(first)));
    expect([notYet.status, notYet.json]).toEqual([503, CANT_CANCEL]);
    delete fake.answer.delete;
    expect((await keep("firstguest", app.cancel(tokenOf(first)))).status).toBe(200);
    await keep(null, app.page(id));
    await keep(null, app.page(other));
    expect(answers).toHaveLength(13);

    const eventIds = [...fake.made];
    expect(eventIds).toHaveLength(2);
    const never = [
      "privacy.host@example.com",
      host.calendarId,
      "Secret Calendar Label",
      "Secret Link Label",
      "Secret Standup",
      "Secret Lunch",
      "Secret Link Event",
      "zz9",
      ...eventIds,
      ...fake.accounts.flatMap((a) => [a.accessToken, a.refreshToken]),
      ...[...busy, live, { start: ist(20, 10, 41), end: ist(20, 10, 43) }].flatMap((b) => [
        String(b.start),
        String(b.end),
        new Date(b.start).toISOString().slice(0, 16),
        new Date(b.end).toISOString().slice(0, 16),
      ]),
    ];
    for (const a of answers) {
      for (const secret of never) expect(a.text, `an answer holds ${secret}`).not.toContain(secret);
      for (const g of ["firstguest", "secondguest", "thirdguest", "fourthguest"]) {
        if (g === a.own) continue;
        expect(a.text).not.toContain(`Guest ${g}`);
        expect(a.text).not.toContain(`${g}@guests.example.org`);
      }
    }
    // And no cancel link reached Google.
    const tokens = [tokenOf(first), tokenOf(second)];
    for (const c of fake.calls) {
      for (const t of tokens) {
        expect(c.url.href).not.toContain(t);
        expect(c.body).not.toContain(t);
      }
    }
  });
});
