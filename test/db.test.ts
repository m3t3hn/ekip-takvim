import { afterEach, beforeAll, describe, expect, it } from "vitest";

// One in-memory database for this file.
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "x".repeat(40);

const db = await import("@/lib/server/db");
const secrets = await import("@/lib/server/secrets");
const viewer = await import("@/lib/server/viewer");
const sync = await import("@/lib/server/sync");

describe("people and calendars", () => {
  beforeAll(() => db.resetAll());

  it("creates someone on first sign-in and updates them after", () => {
    const first = db.upsertGoogleUser({ sub: "1", email: "ahmet@example.com", name: "Ahmet Yılmaz", timezone: "Europe/Istanbul", refreshToken: "t1", calendarAccess: true });
    expect(first.created).toBe(true);
    expect(first.user.id).toBe("ahmet-yilmaz");
    const again = db.upsertGoogleUser({ sub: "1", email: "ahmet@example.com", name: "Ahmet Y.", timezone: "Europe/London", refreshToken: null, calendarAccess: true });
    expect(again.created).toBe(false);
    // Name follows Google; zone stays as they set it; the old token is kept.
    expect(again.user).toMatchObject({ name: "Ahmet Y.", timezone: "Europe/Istanbul", refresh_token: "t1" });
    const twin = db.upsertGoogleUser({ sub: "2", email: "ahmet2@example.com", name: "Ahmet Yılmaz", timezone: "UTC", refreshToken: null, calendarAccess: true });
    expect(twin.user.id).toBe("ahmet-yilmaz-2");
  });

  it("counts only the primary calendar until the person picks others", () => {
    db.syncCalendarList("ahmet-yilmaz", [
      { id: "ahmet@example.com", summary: "ahmet@example.com", access: "events", primary: true },
      { id: "me@gmail.com", summary: "Freelance", access: "freebusy", primary: false },
    ]);
    // Google names the primary calendar after its address; nobody else sees that.
    expect(db.listPeople().find((p) => p.id === "ahmet-yilmaz")?.calendars).toEqual(["Work"]);
    db.updateCalendarChoices("ahmet-yilmaz", [
      { id: "ahmet@example.com", label: "Work", included: true },
      { id: "me@gmail.com", label: "Freelance", included: true },
    ]);
    // A later list from Google keeps those choices and drops calendars that are gone.
    db.syncCalendarList("ahmet-yilmaz", [{ id: "me@gmail.com", summary: "Freelance (renamed)", access: "freebusy", primary: false }]);
    expect(db.listCalendars("ahmet-yilmaz").map((c) => [c.calendar_id, c.label, c.included])).toEqual([["me@gmail.com", "Freelance", 1]]);
  });

  it("returns busy times of counted calendars only", () => {
    db.syncCalendarList("ahmet-yilmaz", [
      { id: "me@gmail.com", summary: "Freelance", access: "freebusy", primary: false },
      { id: "holidays", summary: "Holidays", access: "events", primary: false },
    ]);
    db.setBusy("ahmet-yilmaz", "me@gmail.com", [{ start: 100, end: 200, tentative: true }]);
    db.setBusy("ahmet-yilmaz", "holidays", [{ start: 100, end: 200 }]);
    expect(db.busyBetween(150, 300).map((b) => [b.calendar_id, b.tentative])).toEqual([["me@gmail.com", 1]]);
    expect(db.busyBetween(200, 300)).toEqual([]);
  });

  it("gives everyone their own colour and refuses a taken one", () => {
    const colors = db.listUsers().map((u) => u.color);
    expect(new Set(colors).size).toBe(colors.length);
    const [a, b] = db.listUsers();
    expect(() => db.updateUser(b.id, { color: a.color })).toThrow(/UNIQUE/);
    expect(db.takenColors(a.id).map((t) => t.color)).not.toContain(a.color);
  });

  it("gives events a stable ref that doesn't reveal the calendar", () => {
    const ref = db.eventRef("ahmet-yilmaz", "me@gmail.com", "ev1");
    expect(ref).toBe(db.eventRef("ahmet-yilmaz", "me@gmail.com", "ev1"));
    expect(ref).not.toContain("gmail");
    db.setBusy("ahmet-yilmaz", "me@gmail.com", [{ start: 100, end: 200, title: "Logo", eventId: "ev1", details: { meetLink: "https://meet.google.com/x" } }]);
    expect(db.getEventByRef(ref)).toMatchObject({ title: "Logo", meet_link: "https://meet.google.com/x", label: "Freelance" });
  });

  it("forgets everything about someone who leaves", () => {
    db.deleteUser("ahmet-yilmaz");
    expect(db.listCalendars("ahmet-yilmaz")).toEqual([]);
    expect(db.busyBetween(0, 1000)).toEqual([]);
  });
});

describe("secrets", () => {
  it("round-trips encrypted tokens", () => {
    const sealed = secrets.encrypt("1//refresh-token");
    expect(sealed).not.toContain("refresh");
    expect(secrets.decrypt(sealed)).toBe("1//refresh-token");
  });

  it("accepts its own session cookies and nothing else", () => {
    const user = { id: "elif", session_version: 1, google_sub: "g-elif", email: "elif@example.com" };
    const { value } = secrets.sessionValue(user);
    expect(secrets.verifySession(value)).toEqual({ userId: "elif", version: 1, tag: secrets.identityTag("g-elif") });
    expect(secrets.verifySession(value.replace("elif", "mert"))).toBeNull();
    expect(secrets.verifySession("elif.1.tag.9999999999999.forged")).toBeNull();
  });
});

describe("colour migration", () => {
  it("turns old colour indexes into colours and splits shared ones", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { PRESET_COLORS } = await import("@/lib/colors");
    const conn = new DatabaseSync(":memory:");
    conn.exec("CREATE TABLE users (id TEXT PRIMARY KEY, color INTEGER NOT NULL, created_at INTEGER NOT NULL)");
    conn.exec("INSERT INTO users VALUES ('a', 0, 1), ('b', 1, 2), ('c', 0, 3)");
    db.migrate(conn);
    const rows = conn.prepare("SELECT id, color FROM users ORDER BY id").all() as { id: string; color: string }[];
    expect(rows[0].color).toBe(PRESET_COLORS[0].hex);
    expect(rows[1].color).toBe(PRESET_COLORS[1].hex);
    expect(new Set(rows.map((r) => r.color)).size).toBe(3);
  });
});

describe("sessions", () => {
  beforeAll(() => db.resetAll());

  const signIn = (sub: string, email: string, name: string) =>
    db.upsertGoogleUser({ sub, email, name, timezone: "UTC", refreshToken: "t", calendarAccess: true }).user;

  it("ends every session when someone signs out", () => {
    const user = signIn("g-mert", "mert@example.com", "Mert Demir");
    const laptop = secrets.sessionValue(user).value;
    const phone = secrets.sessionValue(user).value;
    expect(viewer.userForSession(laptop)?.id).toBe("mert-demir");
    db.bumpSessionVersion(user.id);
    expect(viewer.userForSession(laptop)).toBeNull();
    expect(viewer.userForSession(phone)).toBeNull();
    // Signing in again gives a working session.
    expect(viewer.userForSession(secrets.sessionValue(db.getUser(user.id)!).value)?.id).toBe("mert-demir");
  });

  it("doesn't let an old cookie work for a newcomer with the same name", () => {
    const leaver = signIn("g-zeynep-1", "zeynep@example.com", "Zeynep Şahin");
    const oldCookie = secrets.sessionValue(leaver).value;
    db.deleteUser(leaver.id);
    const newcomer = signIn("g-zeynep-2", "zeynep.s@example.com", "Zeynep Şahin");
    // Same name, so the same id…
    expect(newcomer.id).toBe(leaver.id);
    // …but the old cookie was made for another Google account.
    expect(viewer.userForSession(oldCookie)).toBeNull();
    expect(viewer.userForSession(secrets.sessionValue(newcomer).value)?.email).toBe("zeynep.s@example.com");
  });
});

describe("demo mode", () => {
  beforeAll(() => db.resetAll());
  afterEach(() => {
    delete process.env.DEMO_MODE;
    delete process.env.GOOGLE_CLIENT_ID;
  });

  it("never runs next to real Google sign-in", () => {
    process.env.DEMO_MODE = "true";
    expect(secrets.isDemo()).toBe(true);
    process.env.GOOGLE_CLIENT_ID = "123.apps.googleusercontent.com";
    expect(secrets.isDemo()).toBe(false);
  });

  it("doesn't replace a database people have signed in to", async () => {
    const { seedDemo } = await import("@/lib/server/demo");
    const { buildConfig } = await import("@/lib/server/config");
    const config = buildConfig({ timezone: "Europe/Istanbul" });
    expect(seedDemo(config)).toBe(true);
    const demoPeople = db.listUsers().length;
    expect(demoPeople).toBeGreaterThan(0);
    db.upsertGoogleUser({ sub: "g-real", email: "real@example.com", name: "Real Person", timezone: "UTC", refreshToken: "t", calendarAccess: true });
    expect(seedDemo(config)).toBe(false);
    expect(db.getUser("real-person")).not.toBeNull();
    expect(db.listUsers().length).toBe(demoPeople + 1);
  });
});

describe("calendar labels", () => {
  beforeAll(() => db.resetAll());

  it("never hold an email address, since everyone sees them", () => {
    expect(db.safeLabel("ahmet@example.com", true)).toBe("Work");
    expect(db.safeLabel("me@gmail.com", false)).toBe("Personal");
    expect(db.safeLabel("Side job (me@gmail.com)", false)).toBe("Personal");
    expect(db.safeLabel("  Freelance  ", false)).toBe("Freelance");
    expect(db.safeLabel("", false)).toBe("Calendar");
  });

  it("are made safe when calendars arrive and when they're saved", () => {
    const user = db.upsertGoogleUser({ sub: "g-deniz", email: "deniz@example.com", name: "Deniz Aydın", timezone: "UTC", refreshToken: "t", calendarAccess: true }).user;
    db.syncCalendarList(user.id, [
      { id: "deniz@example.com", summary: "deniz@example.com", access: "events", primary: true },
      { id: "deniz.home@gmail.com", summary: "deniz.home@gmail.com", access: "freebusy", primary: false },
    ]);
    expect(db.listCalendars(user.id).map((c) => c.label)).toEqual(["Work", "Personal"]);
    db.updateCalendarChoices(user.id, [{ id: "deniz.home@gmail.com", label: "deniz.home@gmail.com", included: true }]);
    expect(db.listCalendars(user.id).find((c) => c.calendar_id === "deniz.home@gmail.com")?.label).toBe("Personal");
  });

  it("that held an address before are fixed when the app starts", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const conn = new DatabaseSync(":memory:");
    conn.exec("CREATE TABLE users (id TEXT PRIMARY KEY, color TEXT NOT NULL, created_at INTEGER NOT NULL)");
    conn.exec("CREATE TABLE calendars (user_id TEXT, calendar_id TEXT, label TEXT, is_primary INTEGER)");
    conn.exec("INSERT INTO calendars VALUES ('a', 'a@example.com', 'a@example.com', 1), ('a', 'me@gmail.com', 'me@gmail.com', 0), ('a', 'x', 'Freelance', 0)");
    db.migrate(conn);
    const labels = conn.prepare("SELECT label FROM calendars ORDER BY rowid").all() as { label: string }[];
    expect(labels.map((r) => r.label)).toEqual(["Work", "Personal", "Freelance"]);
  });
});

describe("calendars shared later", () => {
  beforeAll(() => db.resetAll());

  it("flags them as new until the person saves their settings", () => {
    const user = db.upsertGoogleUser({ sub: "g-can", email: "can@example.com", name: "Can Öztürk", timezone: "UTC", refreshToken: "t", calendarAccess: true }).user;
    // First list after sign-in: nothing is "new", the settings page asks anyway.
    db.syncCalendarList(user.id, [{ id: "can@example.com", summary: "Can", access: "events", primary: true }]);
    expect(db.newCalendarCount(user.id)).toBe(0);
    // A personal calendar shared into the company account later.
    db.syncCalendarList(user.id, [
      { id: "can@example.com", summary: "Can", access: "events", primary: true },
      { id: "can.personal@gmail.com", summary: "Personal", access: "freebusy", primary: false },
    ]);
    expect(db.newCalendarCount(user.id)).toBe(1);
    expect(db.listCalendars(user.id).find((c) => c.calendar_id === "can.personal@gmail.com")?.included).toBe(0);
    db.updateCalendarChoices(user.id, [{ id: "can.personal@gmail.com", label: "Personal", included: true }]);
    expect(db.newCalendarCount(user.id)).toBe(0);
  });
});

describe("whether someone's free time can be trusted", () => {
  const now = 1_000_000_000_000;
  const user = { refresh_token: "t", token_error: null, calendar_access: 1 };
  const ok = { last_success: now - 60_000, error: null };

  it("is ok with fresh data from every counted calendar", () => {
    expect(sync.dataStatus(user, [ok, ok], now, false)).toBe("ok");
  });

  it("isn't when access is gone or was never there", () => {
    expect(sync.dataStatus({ ...user, token_error: "revoked" }, [ok], now, false)).toBe("signInAgain");
    expect(sync.dataStatus({ ...user, refresh_token: null }, [ok], now, false)).toBe("signInAgain");
    expect(sync.dataStatus({ ...user, calendar_access: 0 }, [ok], now, false)).toBe("noCalendars");
    expect(sync.dataStatus(user, [], now, false)).toBe("noCalendars");
  });

  it("isn't while a calendar is still loading, failing, or hours old", () => {
    expect(sync.dataStatus(user, [ok, { last_success: null, error: null }], now, false)).toBe("syncing");
    expect(sync.dataStatus(user, [ok, { last_success: null, error: "403" }], now, false)).toBe("failing");
    expect(sync.dataStatus(user, [{ last_success: now - 7 * 3_600_000, error: "timeout" }], now, false)).toBe("failing");
    // A recent hiccup on a calendar that has data is only a warning.
    expect(sync.dataStatus(user, [{ last_success: now - 30 * 60_000, error: "timeout" }], now, false)).toBe("ok");
  });

  it("trusts the demo's made-up data however old", () => {
    expect(sync.dataStatus({ ...user, refresh_token: null }, [{ last_success: 1, error: null }], now, true)).toBe("ok");
  });
});
