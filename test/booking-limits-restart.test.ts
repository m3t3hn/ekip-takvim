import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at } from "./booking-reference";
import { LINK_FULL, bookingApp, type Answer, type LinkBody } from "./booking-helpers";

// Booking links, run 2026-11-19-ekip-booking-1b, criterion 1: a link's 30
// bookings an hour are counted from the stored bookings, so a restart doesn't
// clear them. A restart here is what a new process gets: the database file
// opened again, and every module and every bit of in-memory state new.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

const dir = mkdtempSync(join(tmpdir(), "ekip-booking-restart-"));
process.env.DATABASE_PATH = join(dir, "ekip.sqlite");
process.env.SESSION_SECRET = "s".repeat(40);
process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 30\n";
process.env.BOOKING_LINKS = "on";
process.env.DEMO_MODE = "true";
process.env.APP_URL = "https://cal.example.com";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

let app = await bookingApp(jar);

const ist = (d: number, h: number, m = 0) => at("Europe/Istanbul", 2026, 11, d, h, m);
/** Wednesday 2026-11-18, 09:00 in Istanbul. */
const NOW = ist(18, 9);
const MIN = 60_000;
const HOUR = 60 * MIN;
const WIDE: Partial<LinkBody> = { durationMin: 15, startMin: 0, endMin: 1440, days: [0, 1, 2, 3, 4, 5, 6], aheadDays: 3 };

const DB = Symbol.for("ekip-takvim.db");
const LIMITS = Symbol.for("ekip-takvim.booking-limits");
const g = globalThis as Record<symbol, unknown>;

/** A new process: the file opened again, with new modules and no in-memory state. */
async function restart() {
  (g[DB] as DatabaseSync | undefined)?.close();
  delete g[DB];
  delete g[LIMITS];
  vi.resetModules();
  app = await bookingApp(jar);
}

const setNow = (t: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t);
};
let guests = 0;
const valid = (start: number) => ({ start, name: "Restart Guest", email: `restart${++guests}@guests.example.org` });
const answer = (a: Answer) => [a.status, a.json];

beforeEach(() => {
  setNow(NOW);
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("test: no network");
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(() => {
  (g[DB] as DatabaseSync | undefined)?.close();
  delete g[DB];
  rmSync(dir, { recursive: true, force: true });
});

describe("a link's 30 bookings an hour, through a restart", () => {
  it("still refuses the 31st after a restart, while the host's other link books, and books again an hour after the 30", async () => {
    const host = app.person("Restart Host");
    app.signIn(host.id);
    const first = await app.newLink(WIDE);
    const second = await app.newLink(WIDE);
    app.signOut();
    const times = await app.startsOf(first);
    for (let i = 0; i < 30; i++) expect((await app.book(first, valid(times[40 + i]))).status, String(i)).toBe(200);
    const rows = app.bookingRows();
    expect(rows).toHaveLength(30);

    await restart();
    expect(app.bookingRows()).toEqual(rows);
    expect(answer(await app.book(first, valid(times[100])))).toEqual([429, LINK_FULL]);
    expect(app.bookingRows()).toEqual(rows);
    const secondTimes = await app.startsOf(second);
    expect((await app.book(second, valid(secondTimes[100]))).status).toBe(200);

    // Later in the hour, after another restart: still full.
    setNow(NOW + 45 * MIN);
    await restart();
    expect(answer(await app.book(first, valid(times[101])))).toEqual([429, LINK_FULL]);

    // More than an hour after the 30, after a third restart: it books again.
    setNow(NOW + HOUR + 1);
    await restart();
    expect((await app.book(first, valid(times[101]))).status).toBe(200);
  });
});
