import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";

// Booking links, run 2026-11-19-ekip-booking-1b: a link's bookings in the last
// hour are counted from the bookings table, by link and created_at. A database
// feature/booking made before that (at 16bd658) has bookings_by_link on
// link_id alone, stored as "CREATE INDEX bookings_by_link ON bookings
// (link_id)" (read from a file 16bd658 made). Opened here through db(), it gets
// the index a new database gets and keeps every row; opening it again changes
// nothing, schema_version included.

const dir = mkdtempSync(join(tmpdir(), "ekip-booking-index-"));
const oldFile = join(dir, "made-at-16bd658.sqlite");
const freshFile = join(dir, "new.sqlite");

process.env.DATABASE_PATH = freshFile;
process.env.SESSION_SECRET = "x".repeat(40);
const db = await import("@/lib/server/db");

const KEY = Symbol.for("ekip-takvim.db");
const cache = globalThis as typeof globalThis & { [KEY]?: DatabaseSync };
/** Close the connection db() keeps, as a restart would, so the next db() opens the file again. */
function restart() {
  cache[KEY]?.close();
  delete cache[KEY];
}

type Row = Record<string, unknown>;
const all = (conn: DatabaseSync, sql: string) => conn.prepare(sql).all() as Row[];
const master = (conn: DatabaseSync) => all(conn, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name");
const indexColumns = (conn: DatabaseSync, name: string) => all(conn, `PRAGMA index_info(${name})`).map((c) => c.name);
/** Everything in the file: its schema and versions, and every row of every table with its rowid. */
function dump(conn: DatabaseSync) {
  const tables = all(conn, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => String(t.name));
  return {
    master: master(conn),
    schemaVersion: (conn.prepare("PRAGMA schema_version").get() as Row).schema_version,
    userVersion: (conn.prepare("PRAGMA user_version").get() as Row).user_version,
    rows: Object.fromEntries(tables.map((t) => [t, all(conn, `SELECT rowid AS row_id, * FROM "${t}" ORDER BY rowid`)])),
  };
}

const BOOKING_LINK_COLUMNS = [
  "id", "user_id", "title", "description", "duration_min", "days", "start_min", "end_min",
  "buffer_min", "notice_min", "ahead_days", "max_per_day", "meet", "active", "created_at",
];
const BOOKING_COLUMNS = [
  "id", "user_id", "link_id", "title", "start_ms", "end_ms", "guest_name", "guest_email", "note",
  "cancel_hash", "created_at", "cancelled_at", "event_id", "calendar_id",
];

// A new database, as db() makes one.
const fresh = master(db.db());
restart();

// The database as 16bd658 left it, with a host, two links and their bookings.
process.env.DATABASE_PATH = oldFile;
{
  const conn = db.db();
  conn.exec("DROP INDEX bookings_by_link; CREATE INDEX bookings_by_link ON bookings (link_id)");
  conn.exec(`INSERT INTO users (id, google_sub, email, name, team, timezone, color, refresh_token, calendar_access, created_at)
    VALUES ('host-1', 'g-host-1', 'host@example.com', 'Host One', NULL, 'Europe/Istanbul', '#2f7de1', NULL, 1, 1763000000000)`);
  const addLink = conn.prepare(
    `INSERT INTO booking_links (${BOOKING_LINK_COLUMNS.join(", ")}) VALUES (?, 'host-1', 'Intro call', '', 30, '1,2,3,4,5', 600, 720, 0, 0, 3, NULL, 0, 1, 1763000000000)`,
  );
  addLink.run("link-a");
  addLink.run("link-b");
  const addBooking = conn.prepare(
    `INSERT INTO bookings (${BOOKING_COLUMNS.join(", ")}) VALUES (?, 'host-1', ?, 'Intro call', ?, ?, 'Guest', 'guest@guests.example.org', NULL, ?, ?, ?, NULL, NULL)`,
  );
  for (let i = 0; i < 6; i++) {
    const start = 1763100000000 + i * 3_600_000;
    addBooking.run(`booking-${i}`, i < 4 ? "link-a" : "link-b", start, start + 1_800_000, `hash-${i}`, 1763050000000 + i * 60_000, i === 1 ? 1763060000000 : null);
  }
  restart();
}

afterAll(() => {
  restart();
  rmSync(dir, { recursive: true, force: true });
});

// The file before db() opens it again, read without it.
const before = (() => {
  const conn = new DatabaseSync(oldFile, { readOnly: true });
  const out = {
    sql: all(conn, "SELECT sql FROM sqlite_master WHERE name = 'bookings_by_link'").map((r) => r.sql),
    index: indexColumns(conn, "bookings_by_link"),
    bookings: all(conn, "SELECT rowid AS row_id, * FROM bookings ORDER BY rowid"),
  };
  conn.close();
  return out;
})();

describe("a database made at 16bd658, with bookings_by_link on link_id alone", () => {
  it("gets the index a new database gets on open: on link_id and created_at", () => {
    // As 16bd658 left it.
    expect(before.sql).toEqual(["CREATE INDEX bookings_by_link ON bookings (link_id)"]);
    expect(before.index).toEqual(["link_id"]);
    const conn = db.db();
    expect(indexColumns(conn, "bookings_by_link")).toEqual(["link_id", "created_at"]);
    expect(master(conn)).toEqual(fresh);
  });

  it("keeps every booking", () => {
    expect(before.bookings).toHaveLength(6);
    expect(all(db.db(), "SELECT rowid AS row_id, * FROM bookings ORDER BY rowid")).toEqual(before.bookings);
  });

  it("changes nothing when opened again, schema_version included", () => {
    const once = dump(db.db());
    restart();
    const twice = dump(db.db());
    expect(twice.schemaVersion).toBe(once.schemaVersion);
    expect(twice).toEqual(once);
  });
});
