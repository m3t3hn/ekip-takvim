// Writes a consistent copy of the database while the app keeps running.
//
//   node scripts/backup-db.mjs           → backup/ekip-takvim.sqlite next to the database
//   node scripts/backup-db.mjs <file>    → that file
//   node scripts/backup-db.mjs -         → stdout, e.g. from the host:
//     docker compose exec -T ekip-takvim node scripts/backup-db.mjs - > ekip-takvim.sqlite
//
// Copying the live file instead can miss recent writes, because the database
// runs in WAL mode. The copy is as sensitive as the database: people's
// encrypted Google access and their event titles and descriptions.
import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";

const source = resolve(process.env.DATABASE_PATH || "data/ekip-takvim.sqlite");
const arg = process.argv[2];
const toStdout = arg === "-";
const target = toStdout
  ? join(tmpdir(), `ekip-takvim-backup-${process.pid}.sqlite`)
  : resolve(arg || join(dirname(source), "backup", "ekip-takvim.sqlite"));
const partial = `${target}.partial`;

// With stdout taken by the copy, messages go to stderr.
const say = (level, msg, extra) =>
  (toStdout || level === "error" ? console.error : console.log)(JSON.stringify({ level, msg, scope: "backup", ...extra }));

if (!existsSync(source)) {
  say("error", `No database at ${source} yet: nothing to back up`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
rmSync(partial, { force: true });
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("VACUUM INTO ?").run(partial);
} finally {
  db.close();
}
chmodSync(partial, 0o600);

if (toStdout) {
  try {
    await pipeline(createReadStream(partial), process.stdout, { end: false });
  } finally {
    rmSync(partial, { force: true });
  }
  say("info", "database backed up", { to: "stdout" });
} else {
  renameSync(partial, target);
  say("info", "database backed up", { to: target });
}
