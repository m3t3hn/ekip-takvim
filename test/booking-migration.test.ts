import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

// Booking links, criterion 2: a database this branch's base (feature/ics-links)
// made opens here through db() itself, which keeps its connection on
// globalThis, so DATABASE_PATH points at that file before anything opens one.

// What the base's db() leaves in sqlite_master for a new database, in order
// (read from a file it made).
const BASE_SCHEMA = [
  `CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  team TEXT,
  timezone TEXT NOT NULL,
  color TEXT NOT NULL,                -- #rrggbb, unique (see migrate)
  refresh_token TEXT,                 -- encrypted, see secrets.ts
  calendar_access INTEGER NOT NULL DEFAULT 1,
  token_error TEXT,
  sync_error TEXT,                    -- why their calendar list couldn't be read
  created_at INTEGER NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1  -- bumped to end every session (sign out, lost access)
)`,
  `CREATE TABLE calendars (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,          -- Google's id, or "link-" and a random UUID
  summary TEXT NOT NULL,              -- the name in Google Calendar, or a calendar link's host
  label TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('events', 'freebusy')),
  is_primary INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  last_success INTEGER,
  last_attempt INTEGER,
  error TEXT,
  events INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 1,     -- 0: shared after they joined and not reviewed yet
  kind TEXT NOT NULL DEFAULT 'google' CHECK (kind IN ('google', 'link')),
  link TEXT,
  link_etag TEXT,
  link_last_modified TEXT,
  link_full_read INTEGER,
  link_window_from INTEGER,
  link_window_to INTEGER,
  PRIMARY KEY (user_id, calendar_id)
)`,
  `CREATE TABLE busy (
  user_id TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  tentative INTEGER NOT NULL DEFAULT 0,
  all_day INTEGER NOT NULL DEFAULT 0,
  title TEXT,                         -- shown per the rules in sync.ts
  private INTEGER NOT NULL DEFAULT 0,
  ref TEXT,                           -- opaque, stable id the browser uses to open the event
  description TEXT,
  location TEXT,
  meet_link TEXT,
  html_link TEXT,
  FOREIGN KEY (user_id, calendar_id) REFERENCES calendars(user_id, calendar_id) ON DELETE CASCADE
)`,
  "CREATE INDEX busy_by_time ON busy (start_ms, end_ms)",
  "CREATE INDEX busy_by_ref ON busy (ref)",
  "CREATE UNIQUE INDEX users_color ON users (color)",
];

const BASE_DATA = `
INSERT INTO users VALUES
  ('ahmet-yilmaz', 'g-ahmet', 'ahmet@example.com', 'Ahmet Yılmaz', 'Design', 'Europe/Istanbul', '#2f7de1', 'sealed.refresh.token', 1, NULL, NULL, 1700000000000, 3),
  ('elif-kaya', 'g-elif', 'elif@example.com', 'Elif Kaya', NULL, 'Europe/London', '#e5484d', 'sealed.other.token', 1, NULL, NULL, 1700000100000, 1);
INSERT INTO calendars VALUES
  ('ahmet-yilmaz', 'ahmet@example.com', 'ahmet@example.com', 'Work', 'events', 1, 1, 0, 1731400000000, 1731400005000, NULL, 2, 1, 'google', NULL, NULL, NULL, NULL, NULL, NULL),
  ('ahmet-yilmaz', 'link-0f3a9c2e-1111-4a4a-9b9b-123456789abc', 'cal.example.net', 'Side job', 'events', 0, 1, 1000, 1731400000000, 1731400005000, NULL, 1, 1, 'link', 'sealed.link', '"etag-1"', 'Wed, 13 Nov 2024 10:00:00 GMT', 1731400000000, 1727740800000, 1737000000000),
  ('elif-kaya', 'elif@example.com', 'elif@example.com', 'Work', 'events', 1, 1, 0, 1731200000000, 1731200001000, NULL, 1, 1, 'google', NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO busy VALUES
  ('ahmet-yilmaz', 'ahmet@example.com', 1731488400000, 1731492000000, 0, 0, 'Sprint review', 0, 'refA1', 'Agenda: demo', 'Room 4', 'https://meet.google.com/abc-defg-hij', 'https://www.google.com/calendar/event?eid=x'),
  ('ahmet-yilmaz', 'ahmet@example.com', 1731574800000, 1731661200000, 0, 1, 'Off', 1, 'refA2', NULL, NULL, NULL, NULL),
  ('ahmet-yilmaz', 'link-0f3a9c2e-1111-4a4a-9b9b-123456789abc', 1731495600000, 1731499200000, 0, 0, 'Client', 0, 'refA3', NULL, NULL, NULL, NULL),
  ('elif-kaya', 'elif@example.com', 1731488400000, 1731490200000, 0, 0, '1:1', 0, 'refE1', NULL, NULL, NULL, NULL);
`;

const BOOKING_LINK_COLUMNS = [
  "id", "user_id", "title", "description", "duration_min", "days", "start_min", "end_min",
  "buffer_min", "notice_min", "ahead_days", "max_per_day", "meet", "active", "created_at",
];
const BOOKING_COLUMNS = [
  "id", "user_id", "link_id", "title", "start_ms", "end_ms", "guest_name", "guest_email", "note",
  "cancel_hash", "created_at", "cancelled_at", "event_id", "calendar_id",
];

const BASE_USER_COLUMNS = [
  "id", "google_sub", "email", "name", "team", "timezone", "color", "refresh_token",
  "calendar_access", "token_error", "sync_error", "created_at", "session_version",
];

type Row = Record<string, unknown>;
type Column = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };

const dir = mkdtempSync(join(tmpdir(), "ekip-booking-base-"));
const baseFile = join(dir, "made-by-the-base.sqlite");
const freshFile = join(dir, "new.sqlite");

{
  const conn = new DatabaseSync(baseFile);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  for (const sql of BASE_SCHEMA) conn.exec(sql);
  conn.exec(BASE_DATA);
  conn.close();
}
const all = (conn: DatabaseSync, sql: string) => conn.prepare(sql).all() as Row[];
const before = (() => {
  const conn = new DatabaseSync(baseFile, { readOnly: true });
  const out = {
    master: all(conn, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name"),
    users: all(conn, "SELECT rowid AS row_id, * FROM users ORDER BY rowid"),
    calendars: all(conn, "SELECT rowid AS row_id, * FROM calendars ORDER BY rowid"),
    busy: all(conn, "SELECT rowid AS row_id, * FROM busy ORDER BY rowid"),
  };
  conn.close();
  return out;
})();

process.env.DATABASE_PATH = baseFile;
process.env.SESSION_SECRET = "m".repeat(40);
const db = await import("@/lib/server/db");

const KEY = Symbol.for("ekip-takvim.db");
const cache = globalThis as typeof globalThis & { [KEY]?: DatabaseSync };

/** Close the connection db() keeps, as a restart would, so the next db() opens the file again. */
function restart() {
  cache[KEY]?.close();
  delete cache[KEY];
}

function openedFile(conn: DatabaseSync): string {
  const main = (conn.prepare("PRAGMA database_list").all() as { name: string; file: string }[]).find((d) => d.name === "main");
  return realpathSync(main!.file);
}

/** Everything in the file: its schema and versions, and every row of every table with its rowid. */
function dump(conn: DatabaseSync) {
  const tables = all(conn, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => String(t.name));
  return {
    master: all(conn, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name"),
    schemaVersion: (conn.prepare("PRAGMA schema_version").get() as Row).schema_version,
    userVersion: (conn.prepare("PRAGMA user_version").get() as Row).user_version,
    rows: Object.fromEntries(tables.map((t) => [t, all(conn, `SELECT rowid AS row_id, * FROM "${t}" ORDER BY rowid`)])),
  };
}
const columnsOf = (conn: DatabaseSync, table: string) => conn.prepare(`PRAGMA table_info(${table})`).all() as Column[];
const count = (conn: DatabaseSync, sql: string, ...args: string[]) => Number((conn.prepare(sql).get(...args) as { n: number }).n);

function addLink(conn: DatabaseSync, id: string, userId: string) {
  conn
    .prepare(
      `INSERT INTO booking_links (${BOOKING_LINK_COLUMNS.join(", ")}) VALUES (?, ?, 'Intro call', '', 30, '1,2,3,4,5', 600, 720, 0, 240, 14, NULL, 0, 1, 1763000000000)`,
    )
    .run(id, userId);
}
function addBooking(conn: DatabaseSync, id: string, userId: string, linkId: string | null, start: number) {
  conn
    .prepare(
      `INSERT INTO bookings (${BOOKING_COLUMNS.join(", ")}) VALUES (?, ?, ?, 'Intro call', ?, ?, 'Guest', 'guest@guests.example.org', NULL, ?, 1763000000000, NULL, NULL, NULL)`,
    )
    .run(id, userId, linkId, start, start + 1_800_000, `hash-${id}`);
}

afterAll(() => {
  restart();
  rmSync(dir, { recursive: true, force: true });
});

describe("a database made by this branch's base (criterion 2)", () => {
  it("gets booking_links and bookings on first open, and keeps everything else", () => {
    const conn = db.db();
    expect(openedFile(conn)).toBe(realpathSync(baseFile));
    expect(columnsOf(conn, "booking_links").map((c) => c.name)).toEqual(expect.arrayContaining(BOOKING_LINK_COLUMNS));
    expect(columnsOf(conn, "bookings").map((c) => c.name)).toEqual(expect.arrayContaining(BOOKING_COLUMNS));
    // The base's tables and indexes are as they were, with every row, except
    // that users gains booking_access, 0 for everyone (part 2, criterion 2).
    // Changed in run 2026-11-21-ekip-booking-tokens: and calendars gains
    // link_requested, null, from feature/ics-links' later commits merged in at 8d945bd.
    const master = all(conn, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name");
    for (const entry of before.master.filter((m) => m.name !== "users" && m.name !== "calendars")) expect(master, String(entry.name)).toContainEqual(entry);
    const added = master.filter((m) => !before.master.some((b) => b.name === m.name));
    expect(added.every((m) => m.tbl_name === "booking_links" || m.tbl_name === "bookings"), JSON.stringify(added)).toBe(true);
    const baseCalendars = Object.keys(before.calendars[0]).filter((k) => k !== "row_id");
    expect(columnsOf(conn, "calendars").map((c) => c.name)).toEqual([...baseCalendars, "link_requested"]);
    const userColumns = columnsOf(conn, "users").map((c) => c.name);
    expect(userColumns).toEqual(expect.arrayContaining(BASE_USER_COLUMNS));
    expect(userColumns.filter((n) => !BASE_USER_COLUMNS.includes(n))).toEqual(["booking_access"]);
    expect(all(conn, "SELECT rowid AS row_id, * FROM users ORDER BY rowid")).toEqual(before.users.map((u) => ({ ...u, booking_access: 0 })));
    expect(all(conn, "SELECT rowid AS row_id, * FROM calendars ORDER BY rowid")).toEqual(before.calendars.map((c) => ({ ...c, link_requested: null })));
    expect(all(conn, "SELECT rowid AS row_id, * FROM busy ORDER BY rowid")).toEqual(before.busy);
    expect(all(conn, "SELECT * FROM booking_links")).toEqual([]);
    expect(all(conn, "SELECT * FROM bookings")).toEqual([]);
    // And the app reads it as before.
    expect(db.listCalendars("ahmet-yilmaz").map((c) => [c.calendar_id, c.kind, c.label])).toEqual([
      ["ahmet@example.com", "google", "Work"],
      ["link-0f3a9c2e-1111-4a4a-9b9b-123456789abc", "link", "Side job"],
    ]);
  });

  it("changes nothing when opened again, booking rows included", () => {
    const empty = dump(db.db());
    restart();
    expect(dump(db.db())).toEqual(empty);

    const conn = db.db();
    addLink(conn, "link-ahmet-1", "ahmet-yilmaz");
    addLink(conn, "link-elif-1", "elif-kaya");
    addBooking(conn, "booking-ahmet-1", "ahmet-yilmaz", "link-ahmet-1", 1763100000000);
    addBooking(conn, "booking-elif-1", "elif-kaya", "link-elif-1", 1763200000000);
    const withRows = dump(conn);
    restart();
    const again = dump(db.db());
    expect(again.schemaVersion).toBe(withRows.schemaVersion);
    expect(again).toEqual(withRows);
    restart();
    expect(dump(db.db())).toEqual(withRows);
  });

  it("deletes a person's booking links and bookings with them (Remove me), and no one else's", () => {
    const conn = db.db();
    addLink(conn, "link-ahmet-2", "ahmet-yilmaz");
    addBooking(conn, "booking-ahmet-2", "ahmet-yilmaz", "link-ahmet-2", 1763300000000);
    // And one whose link is gone already.
    addBooking(conn, "booking-ahmet-3", "ahmet-yilmaz", null, 1763400000000);
    expect(count(conn, "SELECT COUNT(*) AS n FROM booking_links WHERE user_id = ?", "ahmet-yilmaz")).toBeGreaterThan(0);
    const elifBefore = {
      links: all(conn, "SELECT * FROM booking_links WHERE user_id = 'elif-kaya' ORDER BY rowid"),
      bookings: all(conn, "SELECT * FROM bookings WHERE user_id = 'elif-kaya' ORDER BY rowid"),
    };
    expect(elifBefore.links).toHaveLength(1);

    db.deleteUser("ahmet-yilmaz");
    expect(count(conn, "SELECT COUNT(*) AS n FROM booking_links WHERE user_id = ?", "ahmet-yilmaz")).toBe(0);
    expect(count(conn, "SELECT COUNT(*) AS n FROM bookings WHERE user_id = ?", "ahmet-yilmaz")).toBe(0);
    expect(count(conn, "SELECT COUNT(*) AS n FROM calendars WHERE user_id = ?", "ahmet-yilmaz")).toBe(0);
    expect(all(conn, "SELECT * FROM booking_links WHERE user_id = 'elif-kaya' ORDER BY rowid")).toEqual(elifBefore.links);
    expect(all(conn, "SELECT * FROM bookings WHERE user_id = 'elif-kaya' ORDER BY rowid")).toEqual(elifBefore.bookings);
  });

  it("keeps a link's bookings, with no link, once the link is deleted", () => {
    const conn = db.db();
    conn.prepare("DELETE FROM booking_links WHERE id = ?").run("link-elif-1");
    expect(all(conn, "SELECT id, link_id, cancelled_at FROM bookings WHERE user_id = 'elif-kaya'")).toEqual([
      { id: "booking-elif-1", link_id: null, cancelled_at: null },
    ]);
  });

  it("ends up with the booking tables a new database gets", () => {
    const upgraded = { links: columnsOf(db.db(), "booking_links"), bookings: columnsOf(db.db(), "bookings") };
    restart();
    process.env.DATABASE_PATH = freshFile;
    const conn = db.db();
    expect(openedFile(conn)).toBe(realpathSync(freshFile));
    expect(columnsOf(conn, "booking_links").map((c) => c.name)).toEqual(expect.arrayContaining(BOOKING_LINK_COLUMNS));
    expect(columnsOf(conn, "bookings").map((c) => c.name)).toEqual(expect.arrayContaining(BOOKING_COLUMNS));
    expect(columnsOf(conn, "booking_links")).toEqual(upgraded.links);
    expect(columnsOf(conn, "bookings")).toEqual(upgraded.bookings);
  });
});
