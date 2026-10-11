import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PRESET_COLORS, normalizeColor, pickColor } from "@/lib/colors";
import type { Person } from "@/lib/types";
import { slugify } from "./config";

// People sign in with Google, so everything about them lives here: who they
// are, which of their calendars count, and the busy times last synced from
// those calendars, with event titles and details. Who may see a title is
// decided in sync.ts (mayShowTitle).

const SCHEMA = `
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
`;

export type UserRow = {
  id: string;
  google_sub: string | null;
  email: string;
  name: string;
  team: string | null;
  timezone: string;
  color: string;
  refresh_token: string | null;
  calendar_access: number;
  token_error: string | null;
  sync_error: string | null;
  created_at: number;
  session_version: number;
};

export type CalendarRow = {
  user_id: string;
  calendar_id: string;
  summary: string;
  label: string;
  access: "events" | "freebusy";
  is_primary: number;
  included: number;
  position: number;
  last_success: number | null;
  last_attempt: number | null;
  error: string | null;
  events: number;
  seen: number;
};

export type BusyRow = {
  user_id: string;
  calendar_id: string;
  start_ms: number;
  end_ms: number;
  tentative: number;
  all_day: number;
  title: string | null;
  private: number;
  ref: string | null;
  description: string | null;
  location: string | null;
  meet_link: string | null;
  html_link: string | null;
};

export function databasePath(): string {
  // SQLite's in-memory database (tests): not a file, so don't resolve it.
  if (process.env.DATABASE_PATH === ":memory:") return ":memory:";
  // Runtime-only path, like the config's: keep the bundler from tracing it.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.DATABASE_PATH || "data/ekip-takvim.sqlite");
}

// Route handlers and instrumentation are bundled separately; share one
// connection through the process-wide global.
const KEY = Symbol.for("ekip-takvim.db");
const g = globalThis as typeof globalThis & { [KEY]?: DatabaseSync };

export function db(): DatabaseSync {
  if (g[KEY]) return g[KEY];
  const file = databasePath();
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  conn.exec(SCHEMA);
  migrate(conn);
  g[KEY] = conn;
  return conn;
}

/**
 * Colours used to be an index into the preset list and could repeat. Turn
 * old indexes into their colour, give anyone sharing a colour a free one,
 * then let the database keep them unique.
 */
export function migrate(conn: DatabaseSync): void {
  const columns = (conn.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
  if (columns.length && !columns.includes("sync_error")) conn.exec("ALTER TABLE users ADD COLUMN sync_error TEXT");
  if (columns.length && !columns.includes("session_version")) {
    conn.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1");
  }
  const calendarColumns = (conn.prepare("PRAGMA table_info(calendars)").all() as { name: string }[]).map((c) => c.name);
  if (calendarColumns.length && !calendarColumns.includes("seen")) {
    conn.exec("ALTER TABLE calendars ADD COLUMN seen INTEGER NOT NULL DEFAULT 1");
  }
  // Labels used to default to the calendar's name, which is often its owner's address.
  if (calendarColumns.length) {
    conn.exec("UPDATE calendars SET label = CASE WHEN is_primary = 1 THEN 'Work' ELSE 'Personal' END WHERE label LIKE '%_@_%._%'");
  }
  const busyColumns = (conn.prepare("PRAGMA table_info(busy)").all() as { name: string }[]).map((c) => c.name);
  if (busyColumns.length && !busyColumns.includes("title")) {
    conn.exec("ALTER TABLE busy ADD COLUMN title TEXT; ALTER TABLE busy ADD COLUMN private INTEGER NOT NULL DEFAULT 0;");
  }
  for (const col of ["ref", "description", "location", "meet_link", "html_link"]) {
    if (busyColumns.length && !busyColumns.includes(col)) conn.exec(`ALTER TABLE busy ADD COLUMN ${col} TEXT`);
  }
  if (busyColumns.length) conn.exec("CREATE INDEX IF NOT EXISTS busy_by_ref ON busy (ref)");

  const rows = conn.prepare("SELECT id, color FROM users ORDER BY created_at, id").all() as { id: string; color: unknown }[];
  const used = new Set<string>();
  const update = conn.prepare("UPDATE users SET color = ? WHERE id = ?");
  for (const r of rows) {
    let color =
      typeof r.color === "number" || /^\d+$/.test(String(r.color))
        ? PRESET_COLORS[Number(r.color) % PRESET_COLORS.length].hex
        : normalizeColor(String(r.color));
    if (used.has(color)) color = pickColor(used);
    used.add(color);
    if (color !== r.color) update.run(color, r.id);
  }
  conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_color ON users (color)");
}

/** Run `fn` in one transaction. */
export function transaction<T>(fn: () => T): T {
  const conn = db();
  conn.exec("BEGIN");
  try {
    const out = fn();
    conn.exec("COMMIT");
    return out;
  } catch (err) {
    conn.exec("ROLLBACK");
    throw err;
  }
}

export function listUsers(): UserRow[] {
  return db().prepare("SELECT * FROM users ORDER BY created_at, id").all() as UserRow[];
}

export function getUser(id: string): UserRow | null {
  return (db().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
}

export function listCalendars(userId?: string): CalendarRow[] {
  const sql = "SELECT * FROM calendars" + (userId ? " WHERE user_id = ?" : "") + " ORDER BY user_id, position";
  const stmt = db().prepare(sql);
  return (userId ? stmt.all(userId) : stmt.all()) as CalendarRow[];
}

/** Everyone who signed in, with the labels of the calendars they count. */
export function listPeople(): Person[] {
  const cals = listCalendars().filter((c) => c.included);
  return listUsers().map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    team: u.team,
    color: u.color,
    timezone: u.timezone,
    calendars: cals.filter((c) => c.user_id === u.id).map((c) => c.label),
  }));
}

function uniqueId(name: string, email: string): string {
  const base = slugify(name) || slugify(email.split("@")[0]) || "person";
  const taken = new Set((db().prepare("SELECT id FROM users").all() as { id: string }[]).map((r) => r.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Create or update someone after a Google sign-in. A refresh token is only
 * replaced when Google sent a new one.
 */
export function upsertGoogleUser(input: {
  sub: string;
  email: string;
  name: string;
  timezone: string;
  refreshToken: string | null;
  calendarAccess: boolean;
}): { user: UserRow; created: boolean } {
  const conn = db();
  const existing = conn
    .prepare("SELECT * FROM users WHERE google_sub = ? OR email = ?")
    .get(input.sub, input.email) as UserRow | undefined;
  if (existing) {
    conn
      .prepare(
        `UPDATE users SET google_sub = ?, email = ?, name = ?, calendar_access = ?, token_error = NULL,
           refresh_token = COALESCE(?, refresh_token) WHERE id = ?`,
      )
      .run(input.sub, input.email, input.name, input.calendarAccess ? 1 : 0, input.refreshToken, existing.id);
    return { user: getUser(existing.id)!, created: false };
  }
  const id = uniqueId(input.name, input.email);
  conn
    .prepare(
      `INSERT INTO users (id, google_sub, email, name, team, timezone, color, refresh_token, calendar_access, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sub,
      input.email,
      input.name,
      input.timezone,
      // A random colour nobody has yet; they can change it on their settings page.
      pickColor(takenColors().map((t) => t.color)),
      input.refreshToken,
      input.calendarAccess ? 1 : 0,
      Date.now(),
    );
  return { user: getUser(id)!, created: true };
}

/** Everyone's colour, optionally leaving one person out. */
export function takenColors(exceptUserId?: string): { color: string; name: string }[] {
  return (db().prepare("SELECT id, name, color FROM users ORDER BY created_at, id").all() as { id: string; name: string; color: string }[])
    .filter((u) => u.id !== exceptUserId)
    .map((u) => ({ color: u.color, name: u.name }));
}

export function updateUser(id: string, patch: { team?: string | null; timezone?: string; color?: string }): void {
  const u = getUser(id);
  if (!u) return;
  db()
    .prepare("UPDATE users SET team = ?, timezone = ?, color = ? WHERE id = ?")
    .run(patch.team !== undefined ? patch.team : u.team, patch.timezone ?? u.timezone, patch.color ?? u.color, id);
}

export function setTokenError(id: string, error: string | null): void {
  db().prepare("UPDATE users SET token_error = ? WHERE id = ?").run(error, id);
}

export function setSyncError(id: string, error: string | null): void {
  db().prepare("UPDATE users SET sync_error = ? WHERE id = ?").run(error, id);
}

export function deleteUser(id: string): void {
  db().prepare("DELETE FROM users WHERE id = ?").run(id);
}

/** End every session of this person, on every device. */
export function bumpSessionVersion(id: string): void {
  db().prepare("UPDATE users SET session_version = session_version + 1 WHERE id = ?").run(id);
}

const ADDRESS = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * Everyone who can open the app sees calendar labels, so a label never holds
 * an email address. That matters because Google names primary calendars, and
 * calendars shared from other accounts, after their owner's address.
 */
export function safeLabel(label: string, primary: boolean): string {
  const trimmed = label.trim().slice(0, 40);
  if (!trimmed) return primary ? "Work" : "Calendar";
  if (ADDRESS.test(trimmed)) return primary ? "Work" : "Personal";
  return trimmed;
}

/**
 * Match the stored calendars to the list Google returned: new ones are added
 * (only the primary counted by default), gone ones dropped, labels and
 * choices kept. Calendars that turn up after someone's first sign-in are
 * flagged as new, so they're asked whether those count instead of them
 * silently not counting.
 */
export function syncCalendarList(
  userId: string,
  list: { id: string; summary: string; access: "events" | "freebusy"; primary: boolean }[],
): void {
  transaction(() => {
    const conn = db();
    const known = new Map(listCalendars(userId).map((c) => [c.calendar_id, c]));
    const firstList = known.size === 0;
    list.forEach((c, position) => {
      const prev = known.get(c.id);
      if (prev) {
        conn
          .prepare("UPDATE calendars SET summary = ?, access = ?, is_primary = ?, position = ? WHERE user_id = ? AND calendar_id = ?")
          .run(c.summary, c.access, c.primary ? 1 : 0, position, userId, c.id);
        known.delete(c.id);
      } else {
        conn
          .prepare(
            `INSERT INTO calendars (user_id, calendar_id, summary, label, access, is_primary, included, position, seen)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            userId,
            c.id,
            c.summary,
            safeLabel(c.summary, c.primary),
            c.access,
            c.primary ? 1 : 0,
            c.primary ? 1 : 0,
            position,
            firstList || c.primary ? 1 : 0,
          );
      }
    });
    for (const gone of known.keys()) {
      conn.prepare("DELETE FROM calendars WHERE user_id = ? AND calendar_id = ?").run(userId, gone);
    }
  });
}

export function updateCalendarChoices(userId: string, choices: { id: string; label: string; included: boolean }[]): void {
  transaction(() => {
    const primary = new Set(listCalendars(userId).filter((c) => c.is_primary).map((c) => c.calendar_id));
    const stmt = db().prepare("UPDATE calendars SET label = ?, included = ? WHERE user_id = ? AND calendar_id = ?");
    for (const c of choices) stmt.run(safeLabel(c.label, primary.has(c.id)), c.included ? 1 : 0, userId, c.id);
    // Saving the page is the answer to "do these new calendars count?".
    db().prepare("UPDATE calendars SET seen = 1 WHERE user_id = ?").run(userId);
  });
}

/** Calendars shared with someone since they last saved their settings. */
export function newCalendarCount(userId: string): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM calendars WHERE user_id = ? AND seen = 0").get(userId) as { n: number };
  return row.n;
}

export function markCalendarAttempt(userId: string, calendarId: string): void {
  db()
    .prepare("UPDATE calendars SET last_attempt = ? WHERE user_id = ? AND calendar_id = ?")
    .run(Date.now(), userId, calendarId);
}

export function setCalendarError(userId: string, calendarId: string, error: string): void {
  db()
    .prepare("UPDATE calendars SET error = ?, last_attempt = ? WHERE user_id = ? AND calendar_id = ?")
    .run(error, Date.now(), userId, calendarId);
}

/** Replace a calendar's busy times with a fresh sync. */
export function setBusy(
  userId: string,
  calendarId: string,
  blocks: {
    start: number;
    end: number;
    tentative?: boolean;
    allDay?: boolean;
    title?: string;
    private?: boolean;
    eventId?: string;
    details?: { description?: string; location?: string; meetLink?: string; htmlLink?: string };
  }[],
): void {
  transaction(() => {
    const conn = db();
    conn.prepare("DELETE FROM busy WHERE user_id = ? AND calendar_id = ?").run(userId, calendarId);
    const insert = conn.prepare(
      `INSERT INTO busy (user_id, calendar_id, start_ms, end_ms, tentative, all_day, title, private, ref, description, location, meet_link, html_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of blocks) {
      insert.run(
        userId,
        calendarId,
        b.start,
        b.end,
        b.tentative ? 1 : 0,
        b.allDay ? 1 : 0,
        b.title ?? null,
        b.private ? 1 : 0,
        eventRef(userId, calendarId, b.eventId ?? `${b.start}-${b.end}`),
        b.details?.description ?? null,
        b.details?.location ?? null,
        b.details?.meetLink ?? null,
        b.details?.htmlLink ?? null,
      );
    }
    const now = Date.now();
    conn
      .prepare(
        "UPDATE calendars SET error = NULL, last_success = ?, last_attempt = ?, events = ? WHERE user_id = ? AND calendar_id = ?",
      )
      .run(now, now, blocks.length, userId, calendarId);
  });
}

/**
 * The id the browser gets for an event. Stable across syncs, and a hash so
 * it doesn't give away the calendar's id (a personal address, for shared ones).
 */
export function eventRef(userId: string, calendarId: string, eventId: string): string {
  return createHash("sha256").update(`${userId}\u0000${calendarId}\u0000${eventId}`).digest("base64url").slice(0, 22);
}

export type EventRow = BusyRow & { is_primary: number; label: string; person: string; person_tz: string };

/** One event of a counted calendar, by its ref. */
export function getEventByRef(ref: string): EventRow | null {
  return (
    (db()
      .prepare(
        `SELECT b.*, c.is_primary, c.label, u.name AS person, u.timezone AS person_tz FROM busy b
         JOIN calendars c ON c.user_id = b.user_id AND c.calendar_id = b.calendar_id
         JOIN users u ON u.id = b.user_id
         WHERE b.ref = ? AND c.included = 1`,
      )
      .get(ref) as EventRow | undefined) ?? null
  );
}

/** Busy times of counted calendars overlapping [from, to). */
export function busyBetween(from: number, to: number): BusyRow[] {
  return db()
    .prepare(
      `SELECT b.* FROM busy b
       JOIN calendars c ON c.user_id = b.user_id AND c.calendar_id = b.calendar_id
       WHERE c.included = 1 AND b.start_ms < ? AND b.end_ms > ?
       ORDER BY b.start_ms`,
    )
    .all(to, from) as BusyRow[];
}

/** Wipe everything; the demo starts from a clean database each run. */
export function resetAll(): void {
  db().exec("DELETE FROM busy; DELETE FROM calendars; DELETE FROM users;");
}
