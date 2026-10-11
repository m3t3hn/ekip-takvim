// Puts a backup from backup-db.mjs back in place. Stop the app first, e.g.:
//
//   docker compose stop ekip-takvim
//   docker compose run --rm -T ekip-takvim node scripts/restore-db.mjs - < ekip-takvim.sqlite
//   docker compose start ekip-takvim
//
// Reads the backup from the file given, or from stdin with "-". It's checked
// before anything is replaced, and the database it replaces is kept next to it
// as ekip-takvim.sqlite.before-restore. Restore with the same SESSION_SECRET
// the backup was made with, or everyone has to sign in again.
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";

const args = process.argv.slice(2);
const force = args.includes("--force");
const from = args.find((a) => a !== "--force");
if (!from) fail("usage: node scripts/restore-db.mjs <backup.sqlite | -> [--force]", 2);

const target = resolve(process.env.DATABASE_PATH || "data/ekip-takvim.sqlite");
const incoming = `${target}.restoring`;

// Leaving WAL mode needs every other connection closed, so it only works
// while the app is stopped. It also folds the WAL into the old database,
// which is then kept whole as .before-restore.
if (existsSync(target) && !force) {
  let mode = null;
  try {
    const old = new DatabaseSync(target);
    old.exec("PRAGMA busy_timeout = 0");
    mode = old.prepare("PRAGMA journal_mode = DELETE").get().journal_mode;
    old.close();
  } catch {
    // Locked, or not readable: treated as in use.
  }
  if (mode !== "delete") {
    fail(`The database is in use or can't be opened (${target}). Stop the app first; if the database is damaged, add --force.`);
  }
}

mkdirSync(dirname(target), { recursive: true });
rmSync(incoming, { force: true });
if (from === "-") await pipeline(process.stdin, createWriteStream(incoming));
else copyFileSync(resolve(from), incoming);

try {
  const db = new DatabaseSync(incoming, { readOnly: true });
  const check = db.prepare("PRAGMA integrity_check").get();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  db.close();
  if (check.integrity_check !== "ok") throw new Error(`integrity check says ${check.integrity_check}`);
  if (!["users", "calendars", "busy"].every((t) => tables.includes(t))) throw new Error("not an Ekip Takvim database");
} catch (err) {
  rmSync(incoming, { force: true });
  fail(`Not restored: ${err.message}`);
}

// Keep the replaced database (with any WAL files left) in case this was the wrong backup.
for (const ext of ["", "-wal", "-shm"]) {
  if (existsSync(target + ext)) renameSync(target + ext, `${target}.before-restore${ext}`);
}
chmodSync(incoming, 0o600);
renameSync(incoming, target);
console.log(JSON.stringify({ level: "info", msg: "database restored", scope: "restore", from: from === "-" ? "stdin" : resolve(from), to: target }));

function fail(msg, code = 1) {
  console.error(JSON.stringify({ level: "error", msg, scope: "restore" }));
  process.exit(code);
}
