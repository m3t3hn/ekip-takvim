import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

// Calendar links, criterion 1: a database v1.2.0 made opens in this version
// through db() itself, which keeps its connection on globalThis, so
// DATABASE_PATH points at the old file before anything opens one.

// The schema v1.2.0 created (src/lib/server/db.ts at the v1.2.0 tag), with the
// indexes its migrate() added.
const V1_2_0_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
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
);
CREATE TABLE IF NOT EXISTS calendars (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  summary TEXT NOT NULL,
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
  PRIMARY KEY (user_id, calendar_id)
);
CREATE TABLE IF NOT EXISTS busy (
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
);
CREATE INDEX IF NOT EXISTS busy_by_time ON busy (start_ms, end_ms);
CREATE INDEX IF NOT EXISTS busy_by_ref ON busy (ref);
CREATE UNIQUE INDEX IF NOT EXISTS users_color ON users (color);
`;

const V1_2_0_CALENDAR_COLUMNS = [
  "user_id", "calendar_id", "summary", "label", "access", "is_primary", "included",
  "position", "last_success", "last_attempt", "error", "events", "seen",
];

const OLD_DATA = `
INSERT INTO users VALUES
  ('ahmet-yilmaz', 'g-ahmet', 'ahmet@example.com', 'Ahmet Yılmaz', 'Design', 'Europe/Istanbul', '#2f7de1', 'sealed.refresh.token', 1, NULL, NULL, 1700000000000, 3),
  ('elif-kaya', 'g-elif', 'elif@example.com', 'Elif Kaya', NULL, 'Europe/London', '#e5484d', NULL, 0, 'Google access expired or was revoked', 'Couldn''t read your calendar list from Google', 1700000100000, 1);
INSERT INTO calendars VALUES
  ('ahmet-yilmaz', 'ahmet@example.com', 'ahmet@example.com', 'Work', 'events', 1, 1, 0, 1731400000000, 1731400005000, NULL, 12, 1),
  ('ahmet-yilmaz', 'me@gmail.com', 'Freelance', 'Side gigs', 'freebusy', 0, 1, 1, 1731300000000, 1731400006000, 'Google refused to share this calendar', 3, 1),
  ('ahmet-yilmaz', 'tr.turkish#holiday@group.v.calendar.google.com', 'Holidays in Türkiye', 'Holidays', 'events', 0, 0, 2, NULL, NULL, NULL, 0, 0),
  ('elif-kaya', 'elif@example.com', 'elif@example.com', 'Work', 'events', 1, 1, 0, 1731200000000, 1731200001000, NULL, 1, 1);
INSERT INTO busy VALUES
  ('ahmet-yilmaz', 'ahmet@example.com', 1731488400000, 1731492000000, 0, 0, 'Sprint review', 0, 'refA1', 'Agenda: demo', 'Room 4', 'https://meet.google.com/abc-defg-hij', 'https://www.google.com/calendar/event?eid=x'),
  ('ahmet-yilmaz', 'ahmet@example.com', 1731574800000, 1731661200000, 0, 1, 'Off', 1, 'refA2', NULL, NULL, NULL, NULL),
  ('ahmet-yilmaz', 'me@gmail.com', 1731495600000, 1731499200000, 1, 0, NULL, 0, 'refA3', NULL, NULL, NULL, NULL),
  ('elif-kaya', 'elif@example.com', 1731488400000, 1731490200000, 0, 0, '1:1', 0, 'refE1', NULL, NULL, NULL, NULL);
`;

type Row = Record<string, unknown>;
type Column = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };

const dir = mkdtempSync(join(tmpdir(), "ekip-v120-"));
const oldFile = join(dir, "made-by-v1.2.0.sqlite");
const freshFile = join(dir, "new.sqlite");

// Made the way v1.2.0 made it: WAL, its schema, people with Google calendars and busy times.
{
  const conn = new DatabaseSync(oldFile);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  conn.exec(V1_2_0_SCHEMA);
  conn.exec(OLD_DATA);
  conn.close();
}
const before = (() => {
  const conn = new DatabaseSync(oldFile, { readOnly: true });
  const all = (sql: string) => conn.prepare(sql).all() as Row[];
  const out = {
    users: all("SELECT * FROM users ORDER BY rowid"),
    calendars: all("SELECT * FROM calendars ORDER BY rowid"),
    busy: all("SELECT * FROM busy ORDER BY rowid"),
  };
  conn.close();
  return out;
})();

process.env.DATABASE_PATH = oldFile;
process.env.SESSION_SECRET = "m".repeat(40);
delete process.env.CALENDAR_LINKS;
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

/** Everything in the file: schema, every row with its rowid, and the schema version. */
function dump(conn: DatabaseSync) {
  const all = (sql: string) => conn.prepare(sql).all() as Row[];
  return {
    schema: all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"),
    schemaVersion: (conn.prepare("PRAGMA schema_version").get() as Row).schema_version,
    users: all("SELECT rowid AS row_id, * FROM users ORDER BY rowid"),
    calendars: all("SELECT rowid AS row_id, * FROM calendars ORDER BY rowid"),
    busy: all("SELECT rowid AS row_id, * FROM busy ORDER BY rowid"),
  };
}

const columnsOf = (conn: DatabaseSync) => conn.prepare("PRAGMA table_info(calendars)").all() as Column[];
const pick = (row: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));

afterAll(() => {
  restart();
  rmSync(dir, { recursive: true, force: true });
});

describe("a database made by v1.2.0 (criterion 1)", () => {
  let upgradedColumns: Column[] = [];

  it("gets the new calendar columns on first open, its calendars becoming Google ones with everything else kept", () => {
    const conn = db.db();
    expect(openedFile(conn)).toBe(realpathSync(oldFile));
    upgradedColumns = columnsOf(conn);
    const names = upgradedColumns.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining([...V1_2_0_CALENDAR_COLUMNS, "kind"]));
    // The link, its ETag, Last-Modified and full-read time need columns of their own.
    expect(names.length).toBeGreaterThanOrEqual(V1_2_0_CALENDAR_COLUMNS.length + 1 + 4);
    const added = names.filter((n) => !V1_2_0_CALENDAR_COLUMNS.includes(n) && n !== "kind");

    const calendars = conn.prepare("SELECT * FROM calendars ORDER BY rowid").all() as Row[];
    expect(calendars).toHaveLength(before.calendars.length);
    calendars.forEach((row, i) => {
      expect(row.kind, String(row.calendar_id)).toBe("google");
      expect(pick(row, V1_2_0_CALENDAR_COLUMNS)).toEqual(before.calendars[i]);
      // A Google calendar has no link, version or read time.
      for (const name of added) expect(row[name], `${row.calendar_id}.${name}`).toBeNull();
    });
    expect(conn.prepare("SELECT * FROM busy ORDER BY rowid").all()).toEqual(before.busy);
    // Booking links part 2 (criterion 2) adds users.booking_access: 0 for everyone already here.
    expect(conn.prepare("SELECT * FROM users ORDER BY rowid").all()).toEqual(before.users.map((u) => ({ ...u, booking_access: 0 })));

    // And the app reads them as before.
    expect(db.listCalendars("ahmet-yilmaz").map((c) => [c.calendar_id, c.kind, c.label, c.included])).toEqual([
      ["ahmet@example.com", "google", "Work", 1],
      ["me@gmail.com", "google", "Side gigs", 1],
      ["tr.turkish#holiday@group.v.calendar.google.com", "google", "Holidays", 0],
    ]);
    expect(db.busyBetween(0, 2_000_000_000_000).map((b) => b.ref).sort()).toEqual(["refA1", "refA2", "refA3", "refE1"]);
  });

  it("changes nothing when opened a second time", () => {
    const first = dump(db.db());
    restart();
    const conn = db.db();
    expect(openedFile(conn)).toBe(realpathSync(oldFile));
    expect(dump(conn)).toEqual(first);
  });

  it("takes calendar links once upgraded, and keeps them when opened again", () => {
    const link = "https://cal.example.com/private/0f3a9c/basic.ics";
    const id = db.addLinkCalendar("ahmet-yilmaz", link, "Side job");
    db.setBusy("ahmet-yilmaz", id, [{ start: 1731600000000, end: 1731603600000, title: "Client", eventId: "c1" }]);
    expect(db.listCalendars("ahmet-yilmaz").map((c) => c.kind)).toEqual(["google", "google", "google", "link"]);
    expect(db.linkOf("ahmet-yilmaz", id)).toBe(link);

    const withLink = dump(db.db());
    restart();
    expect(dump(db.db())).toEqual(withLink);
    expect(db.listCalendars("ahmet-yilmaz").map((c) => c.kind)).toEqual(["google", "google", "google", "link"]);
    expect(db.linkOf("ahmet-yilmaz", id)).toBe(link);
  });

  it("ends up with the calendars columns a new database gets", () => {
    restart();
    process.env.DATABASE_PATH = freshFile;
    const conn = db.db();
    expect(openedFile(conn)).toBe(realpathSync(freshFile));
    const shape = (columns: Column[]) =>
      Object.fromEntries(columns.map((c) => [c.name, { type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }]));
    expect(shape(upgradedColumns)).toEqual(shape(columnsOf(conn)));
  });
});
