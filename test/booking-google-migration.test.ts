import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

// Booking links, part 2 (run 2026-11-19-ekip-booking-2), criterion 2: a
// database part 1 made gains users.booking_access (default 0) when it's
// opened through db() itself, and opening it again changes nothing. db()
// keeps its connection on globalThis, so DATABASE_PATH points at the file
// before anything opens one.

// What part 1's db() (f1c9eec) leaves in sqlite_master for a new database, in
// order (read from a file it made).
const PART1_SCHEMA = [
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
  `CREATE TABLE booking_links (
  id TEXT PRIMARY KEY,                -- the token in the link's address
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL,
  days TEXT NOT NULL,                 -- the weekdays it offers, e.g. "1,2,3,4,5" (0 = Sunday)
  start_min INTEGER NOT NULL,         -- the daily window on the host's clock, minutes after midnight
  end_min INTEGER NOT NULL,
  buffer_min INTEGER NOT NULL DEFAULT 0,
  notice_min INTEGER NOT NULL DEFAULT 0,
  ahead_days INTEGER NOT NULL,
  max_per_day INTEGER,                -- null: no cap
  meet INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
)`,
  "CREATE INDEX booking_links_by_user ON booking_links (user_id)",
  `CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the host
  link_id TEXT REFERENCES booking_links(id) ON DELETE SET NULL,
  title TEXT NOT NULL,                -- the link's title when booked
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  note TEXT,
  cancel_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the cancel token; the token isn't kept
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  event_id TEXT,                      -- the host's Google event, once there is one
  calendar_id TEXT
)`,
  "CREATE INDEX bookings_by_user ON bookings (user_id, end_ms)",
  "CREATE INDEX bookings_by_link ON bookings (link_id, created_at)",
  "CREATE INDEX busy_by_ref ON busy (ref)",
  "CREATE UNIQUE INDEX users_color ON users (color)",
];

const PART1_USER_COLUMNS = [
  "id", "google_sub", "email", "name", "team", "timezone", "color", "refresh_token",
  "calendar_access", "token_error", "sync_error", "created_at", "session_version",
];
const PART1_BOOKING_COLUMNS = [
  "id", "user_id", "link_id", "title", "start_ms", "end_ms", "guest_name", "guest_email", "note",
  "cancel_hash", "created_at", "cancelled_at", "event_id", "calendar_id",
];

const PART1_DATA = `
INSERT INTO users VALUES
  ('ahmet-yilmaz', 'g-ahmet', 'ahmet@example.com', 'Ahmet Yılmaz', 'Design', 'Europe/Istanbul', '#2f7de1', 'sealed.refresh.token', 1, NULL, NULL, 1700000000000, 3),
  ('elif-kaya', 'g-elif', 'elif@example.com', 'Elif Kaya', NULL, 'Europe/London', '#e5484d', 'sealed.other.token', 0, 'Google access expired or was revoked', NULL, 1700000100000, 1);
INSERT INTO calendars VALUES
  ('ahmet-yilmaz', 'ahmet@example.com', 'ahmet@example.com', 'Work', 'events', 1, 1, 0, 1731400000000, 1731400005000, NULL, 2, 1, 'google', NULL, NULL, NULL, NULL, NULL, NULL),
  ('elif-kaya', 'elif@example.com', 'elif@example.com', 'Work', 'events', 1, 1, 0, 1731200000000, 1731200001000, NULL, 1, 1, 'google', NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO busy VALUES
  ('ahmet-yilmaz', 'ahmet@example.com', 1731488400000, 1731492000000, 0, 0, 'Sprint review', 0, 'refA1', 'Agenda: demo', 'Room 4', NULL, NULL),
  ('elif-kaya', 'elif@example.com', 1731488400000, 1731490200000, 0, 0, '1:1', 0, 'refE1', NULL, NULL, NULL, NULL);
INSERT INTO booking_links VALUES
  ('link-ahmet-1', 'ahmet-yilmaz', 'Intro call', 'A first chat', 30, '1,2,3,4,5', 600, 720, 0, 240, 14, NULL, 1, 1, 1763000000000);
INSERT INTO bookings VALUES
  ('booking-1', 'ahmet-yilmaz', 'link-ahmet-1', 'Intro call', 1763100000000, 1763101800000, 'Guest One', 'one@guests.example.org', 'Hello', 'hash-1', 1763000100000, NULL, NULL, NULL),
  ('booking-2', 'ahmet-yilmaz', 'link-ahmet-1', 'Intro call', 1763200000000, 1763201800000, 'Guest Two', 'two@guests.example.org', NULL, 'hash-2', 1763000200000, 1763000300000, NULL, NULL);
`;

type Row = Record<string, unknown>;
type Column = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };

const dir = mkdtempSync(join(tmpdir(), "ekip-booking-part1-"));
const part1File = join(dir, "made-by-part-1.sqlite");
const freshFile = join(dir, "new.sqlite");

{
  const conn = new DatabaseSync(part1File);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  for (const sql of PART1_SCHEMA) conn.exec(sql);
  conn.exec(PART1_DATA);
  conn.close();
}
const all = (conn: DatabaseSync, sql: string) => conn.prepare(sql).all() as Row[];
const TABLES = ["users", "calendars", "busy", "booking_links", "bookings"];
const before = (() => {
  const conn = new DatabaseSync(part1File, { readOnly: true });
  const out = {
    master: all(conn, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name"),
    rows: Object.fromEntries(TABLES.map((t) => [t, all(conn, `SELECT rowid AS row_id, * FROM "${t}" ORDER BY rowid`)])),
  };
  conn.close();
  return out;
})();

process.env.DATABASE_PATH = part1File;
process.env.SESSION_SECRET = "p".repeat(40);
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
const pick = (row: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));

afterAll(() => {
  restart();
  rmSync(dir, { recursive: true, force: true });
});

describe("a database made by part 1 (criterion 2)", () => {
  let upgradedUsers: Column[] = [];

  it("gains users.booking_access, default 0, on first open, with every row kept", () => {
    const conn = db.db();
    expect(openedFile(conn)).toBe(realpathSync(part1File));
    upgradedUsers = columnsOf(conn, "users");
    expect(upgradedUsers.map((c) => c.name)).toEqual(expect.arrayContaining([...PART1_USER_COLUMNS, "booking_access"]));
    const column = upgradedUsers.find((c) => c.name === "booking_access")!;
    expect(column.type.toUpperCase()).toBe("INTEGER");
    expect(String(column.dflt_value)).toBe("0");
    // Everyone already here has 0, and keeps the rest.
    const users = all(conn, "SELECT rowid AS row_id, * FROM users ORDER BY rowid");
    expect(users.map((u) => u.booking_access)).toEqual([0, 0]);
    expect(users.map((u) => pick(u, ["row_id", ...PART1_USER_COLUMNS]))).toEqual(before.rows.users);
    // The other tables keep every row. Changed in run 2026-11-21-ekip-booking-tokens:
    // calendars gains feature/ics-links' link_requested, null, merged in at 8d945bd.
    for (const t of ["calendars", "busy", "booking_links"]) {
      const kept = t === "calendars" ? before.rows[t].map((r) => ({ ...r, link_requested: null })) : before.rows[t];
      expect(all(conn, `SELECT rowid AS row_id, * FROM "${t}" ORDER BY rowid`), t).toEqual(kept);
    }
    const bookings = all(conn, "SELECT rowid AS row_id, * FROM bookings ORDER BY rowid");
    expect(bookings.map((b) => pick(b, ["row_id", ...PART1_BOOKING_COLUMNS]))).toEqual(before.rows.bookings);
    // Part 1's tables and indexes other than users, bookings and calendars are as
    // they were; calendars has part 1's columns, then link_requested.
    const master = all(conn, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name");
    for (const entry of before.master.filter((m) => !["users", "bookings", "calendars"].includes(String(m.name)))) {
      expect(master, String(entry.name)).toContainEqual(entry);
    }
    const part1Calendars = Object.keys(before.rows.calendars[0]).filter((k) => k !== "row_id");
    expect(columnsOf(conn, "calendars").map((c) => c.name)).toEqual([...part1Calendars, "link_requested"]);
    // And the app reads the column.
    expect(db.getUser("ahmet-yilmaz")!.booking_access).toBe(0);
    // Someone added without it gets the default.
    conn
      .prepare("INSERT INTO users (id, email, name, timezone, color, created_at) VALUES ('new-person', 'new@example.com', 'New', 'UTC', '#010203', 1)")
      .run();
    expect(db.getUser("new-person")!.booking_access).toBe(0);
    conn.prepare("DELETE FROM users WHERE id = 'new-person'").run();
  });

  it("changes nothing when opened again", () => {
    // Someone allowed booking links since (a sign-in stores 1).
    db.db().prepare("UPDATE users SET booking_access = 1 WHERE id = 'ahmet-yilmaz'").run();
    const first = dump(db.db());
    restart();
    const conn = db.db();
    expect(openedFile(conn)).toBe(realpathSync(part1File));
    const second = dump(conn);
    expect(second.schemaVersion).toBe(first.schemaVersion);
    expect(second).toEqual(first);
    restart();
    expect(dump(db.db())).toEqual(first);
  });

  it("ends up with the users columns a new database gets", () => {
    restart();
    process.env.DATABASE_PATH = freshFile;
    const conn = db.db();
    expect(openedFile(conn)).toBe(realpathSync(freshFile));
    const shape = (columns: Column[]) => Object.fromEntries(columns.map((c) => [c.name, { type: c.type, dflt_value: c.dflt_value }]));
    expect(shape(columnsOf(conn, "users"))).toEqual(shape(upgradedUsers));
  });
});
