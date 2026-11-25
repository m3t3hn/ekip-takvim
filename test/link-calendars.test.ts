import { beforeEach, describe, expect, it } from "vitest";

// Calendar links, criteria 2 to 4: adding, removing and keeping link calendars
// in the database. One in-memory database for this file.
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "c".repeat(40);
delete process.env.CALENDAR_LINKS;
delete process.env.DEMO_MODE;

const db = await import("@/lib/server/db");
const secrets = await import("@/lib/server/secrets");
const { mySettings } = await import("@/lib/server/me");

type Row = Record<string, unknown>;
type GoogleEntry = { id: string; summary: string; access: "events" | "freebusy"; primary: boolean };

const LINK = "https://p52-caldav.example.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Ng/feed.ics?token=Zx9QsecretQ7";
const HOST = "p52-caldav.example.com";
// What of the link is its secret: the path and the query.
const SECRET_PARTS = ["/published/2/", "MTIzNDU2Nzg5MDEyMzQ1Ng", "feed.ics", "Zx9QsecretQ7", "token="];
const OTHER_LINK = "https://outlook.example.net/owa/calendar/abc123def/reachcalendar.ics";

const GOOGLE: GoogleEntry[] = [
  { id: "ahmet@example.com", summary: "ahmet@example.com", access: "events", primary: true },
  { id: "me@gmail.com", summary: "Freelance", access: "freebusy", primary: false },
];

let n = 0;
function person(name: string) {
  n++;
  return db.upsertGoogleUser({ sub: `g-${n}`, email: `p${n}@example.com`, name, timezone: "Europe/Istanbul", refreshToken: null, calendarAccess: true }).user;
}

const all = (sql: string, ...params: string[]) => db.db().prepare(sql).all(...params) as Row[];
const calendarRows = () => all("SELECT * FROM calendars ORDER BY rowid");
const busyRows = () => all("SELECT * FROM busy ORDER BY rowid");
const busyOf = (userId: string, calendarId: string) =>
  all("SELECT * FROM busy WHERE user_id = ? AND calendar_id = ? ORDER BY rowid", userId, calendarId);
const block = (start: number, title: string) => ({ start, end: start + 1_800_000, title, eventId: title });

beforeEach(() => db.resetAll());

describe("addLinkCalendar (criterion 2)", () => {
  it("stores a counted, not new calendar of kind link, named after the link's host, and returns its id", () => {
    const ahmet = person("Ahmet Yılmaz");
    db.syncCalendarList(ahmet.id, GOOGLE);
    const id = db.addLinkCalendar(ahmet.id, LINK, "Side job");
    expect(typeof id).toBe("string");

    const mine = db.listCalendars(ahmet.id);
    const link = mine.find((c) => c.calendar_id === id)!;
    expect(link).toBeDefined();
    expect(link).toMatchObject({ user_id: ahmet.id, kind: "link", summary: HOST, label: "Side job" });
    expect(link.included).toBeTruthy();
    expect(db.newCalendarCount(ahmet.id)).toBe(0);
    expect(mySettings(ahmet.id)!.calendars.find((c) => c.id === id)).toMatchObject({
      kind: "link",
      summary: HOST,
      label: "Side job",
      included: true,
      isNew: false,
    });
    // Counted straight away: its label is among the person's calendars.
    expect(db.listPeople().find((p) => p.id === ahmet.id)!.calendars).toContain("Side job");
  });

  it("is only the person's own", () => {
    const ahmet = person("Ahmet Yılmaz");
    const elif = person("Elif Kaya");
    const id = db.addLinkCalendar(ahmet.id, LINK, "Side job");
    expect(db.listCalendars(elif.id)).toEqual([]);
    expect(db.listCalendars(ahmet.id).map((c) => c.calendar_id)).toEqual([id]);
  });

  it("lists link calendars after the person's Google calendars, also when Google lists more later", () => {
    const ahmet = person("Ahmet Yılmaz");
    db.syncCalendarList(ahmet.id, GOOGLE);
    const first = db.addLinkCalendar(ahmet.id, LINK, "Side job");
    const second = db.addLinkCalendar(ahmet.id, OTHER_LINK, "Choir");
    db.syncCalendarList(ahmet.id, [
      ...GOOGLE,
      { id: "team@group.calendar.google.com", summary: "Team", access: "events", primary: false },
      { id: "holidays@group.v.calendar.google.com", summary: "Holidays", access: "events", primary: false },
    ]);
    const kinds = db.listCalendars(ahmet.id).map((c) => c.kind);
    expect(kinds).toEqual(["google", "google", "google", "google", "link", "link"]);
    expect(db.listCalendars(ahmet.id).slice(4).map((c) => c.calendar_id).sort()).toEqual([first, second].sort());
    expect(mySettings(ahmet.id)!.calendars.map((c) => c.kind)).toEqual(kinds);
  });

  it("gives the label the email-address rule other labels get", () => {
    const ahmet = person("Ahmet Yılmaz");
    for (const label of ["  Side job  ", "me@icloud.com", "Side job (me@gmail.com)", "x".repeat(60), "Choir"]) {
      const id = db.addLinkCalendar(ahmet.id, LINK, label);
      expect(db.listCalendars(ahmet.id).find((c) => c.calendar_id === id)!.label, label).toBe(db.safeLabel(label, false));
    }
    expect(db.listCalendars(ahmet.id).map((c) => c.label)).not.toContain("me@icloud.com");
  });

  it("keeps the link only encrypted, and linkOf gives it back", () => {
    const ahmet = person("Ahmet Yılmaz");
    db.syncCalendarList(ahmet.id, GOOGLE);
    const id = db.addLinkCalendar(ahmet.id, LINK, "Side job");

    for (const row of calendarRows()) {
      for (const [column, value] of Object.entries(row)) {
        const text = String(value);
        expect(text, column).not.toContain(LINK);
        for (const part of SECRET_PARTS) expect(text, `${column} holds ${part}`).not.toContain(part);
      }
    }
    // One column holds it, sealed with encrypt() from secrets.ts.
    const row = all("SELECT * FROM calendars WHERE calendar_id = ?", id)[0];
    const opened = Object.values(row).flatMap((value) => {
      if (typeof value !== "string") return [];
      try {
        return [secrets.decrypt(value)];
      } catch {
        return [];
      }
    });
    expect(opened).toEqual([LINK]);
    expect(db.linkOf(ahmet.id, id)).toBe(LINK);
  });
});

describe("removeLinkCalendar (criterion 3)", () => {
  it("deletes the person's link calendar with its busy rows and nothing else", () => {
    const ahmet = person("Ahmet Yılmaz");
    const elif = person("Elif Kaya");
    db.syncCalendarList(ahmet.id, GOOGLE);
    const side = db.addLinkCalendar(ahmet.id, LINK, "Side job");
    const choir = db.addLinkCalendar(ahmet.id, OTHER_LINK, "Choir");
    const elifs = db.addLinkCalendar(elif.id, LINK, "Yoga");
    db.setBusy(ahmet.id, "ahmet@example.com", [block(1000, "standup")]);
    db.setBusy(ahmet.id, side, [block(2000, "client"), block(3000, "review")]);
    db.setBusy(ahmet.id, choir, [block(4000, "rehearsal")]);
    db.setBusy(elif.id, elifs, [block(5000, "yoga")]);
    const calendarsBefore = calendarRows();
    const busyBefore = busyRows();
    expect(busyOf(ahmet.id, side)).toHaveLength(2);

    expect(db.removeLinkCalendar(ahmet.id, side)).toBe(true);
    expect(db.listCalendars(ahmet.id).map((c) => c.calendar_id)).not.toContain(side);
    expect(busyOf(ahmet.id, side)).toEqual([]);
    expect(calendarRows()).toEqual(calendarsBefore.filter((c) => c.calendar_id !== side));
    expect(busyRows()).toEqual(busyBefore.filter((b) => b.calendar_id !== side));
  });

  it("changes nothing for a Google calendar, another person's calendar or an unknown id", () => {
    const ahmet = person("Ahmet Yılmaz");
    const elif = person("Elif Kaya");
    db.syncCalendarList(ahmet.id, GOOGLE);
    const side = db.addLinkCalendar(ahmet.id, LINK, "Side job");
    const elifs = db.addLinkCalendar(elif.id, LINK, "Yoga");
    db.setBusy(ahmet.id, "ahmet@example.com", [block(1000, "standup")]);
    db.setBusy(ahmet.id, "me@gmail.com", [block(1500, "gig")]);
    db.setBusy(ahmet.id, side, [block(2000, "client")]);
    db.setBusy(elif.id, elifs, [block(5000, "yoga")]);
    const calendarsBefore = calendarRows();
    const busyBefore = busyRows();

    for (const [who, id] of [
      [ahmet.id, "ahmet@example.com"],
      [ahmet.id, "me@gmail.com"],
      [ahmet.id, elifs],
      [elif.id, side],
      [ahmet.id, "link-00000000-0000-4000-8000-000000000000"],
      [ahmet.id, ""],
    ]) {
      expect(db.removeLinkCalendar(who, id), `${who} ${id}`).toBe(false);
      expect(calendarRows()).toEqual(calendarsBefore);
      expect(busyRows()).toEqual(busyBefore);
    }
    // Gone already: unknown now.
    expect(db.removeLinkCalendar(ahmet.id, side)).toBe(true);
    expect(db.removeLinkCalendar(ahmet.id, side)).toBe(false);
  });
});

describe("syncCalendarList with link calendars (criterion 4)", () => {
  it("adds, updates and removes Google calendars and leaves link calendars as they were", () => {
    const ahmet = person("Ahmet Yılmaz");
    db.syncCalendarList(ahmet.id, GOOGLE);
    const side = db.addLinkCalendar(ahmet.id, LINK, "Side job");
    const choir = db.addLinkCalendar(ahmet.id, OTHER_LINK, "Choir");
    // Relabelled and unticked like any calendar, on the settings page.
    db.updateCalendarChoices(ahmet.id, [
      { id: "ahmet@example.com", label: "Work", included: true },
      { id: "me@gmail.com", label: "Freelance", included: true },
      { id: side, label: "Evenings", included: false },
      { id: choir, label: "Choir", included: true },
    ]);
    db.setBusy(ahmet.id, side, [block(2000, "client")]);
    db.setBusy(ahmet.id, choir, [block(3000, "rehearsal"), block(4000, "concert")]);
    db.setBusy(ahmet.id, "me@gmail.com", [block(1000, "gig")]);
    const links = () => all("SELECT * FROM calendars WHERE calendar_id IN (?, ?) ORDER BY calendar_id", side, choir);
    const linkBusy = () => all("SELECT * FROM busy WHERE calendar_id IN (?, ?) ORDER BY rowid", side, choir);
    const linksBefore = links();
    const busyBefore = linkBusy();
    expect(linksBefore.map((c) => [c.label, c.included])).toEqual(
      [side, choir].sort().map((id) => (id === side ? ["Evenings", 0] : ["Choir", 1])),
    );

    db.syncCalendarList(ahmet.id, [
      { id: "ahmet@example.com", summary: "Ahmet (work)", access: "events", primary: true },
      { id: "team@group.calendar.google.com", summary: "Team", access: "freebusy", primary: false },
    ]);
    const google = db.listCalendars(ahmet.id).filter((c) => c.calendar_id !== side && c.calendar_id !== choir);
    expect(google.map((c) => [c.calendar_id, c.summary, c.included])).toEqual([
      ["ahmet@example.com", "Ahmet (work)", 1],
      ["team@group.calendar.google.com", "Team", 0],
    ]);
    expect(busyOf(ahmet.id, "me@gmail.com")).toEqual([]);
    expect(links()).toEqual(linksBefore);
    expect(linkBusy()).toEqual(busyBefore);
    expect(db.listCalendars(ahmet.id).map((c) => c.kind)).toEqual(["google", "google", "link", "link"]);

    // Google lists nothing at all: the Google calendars go, the links stay.
    db.syncCalendarList(ahmet.id, []);
    expect(db.listCalendars(ahmet.id).map((c) => c.calendar_id).sort()).toEqual([side, choir].sort());
    expect(links()).toEqual(linksBefore);
    expect(linkBusy()).toEqual(busyBefore);
  });
});
