import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { fakeGoogle, held, plans, type FakeGoogle } from "./google-token-fake";
import { captureConsole } from "./link-helpers";

// Sync every minute, criterion 1: with no refresh_minutes in the config (no
// file, or one without it) rounds run one minute apart, the scheduler waiting a
// minute after a round ends, also when the config doesn't load; a config that
// sets it keeps it, from 1 to 1440. The scheduler is module state, so each of
// its tests starts a fresh sync module on fake timers. Google is a fetch stub.
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "m".repeat(40);
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
delete process.env.DEMO_MODE;
delete process.env.EXPOSURE;
delete process.env.APP_URL;
delete process.env.CONFIG_PATH;
delete process.env.CONFIG_YAML;

const { ConfigError, buildConfig, loadConfig, loadConfigFile } = await import("@/lib/server/config");
const db = await import("@/lib/server/db");
const secrets = await import("@/lib/server/secrets");

const MIN = 60_000;
const dir = mkdtempSync(path.join(os.tmpdir(), "ekip-refresh-"));
/** Where the server would run with no config file: config/app.yaml isn't there. */
const nowhere = path.join(dir, "no-config-here");
mkdirSync(nowhere);
const withoutIt = path.join(dir, "without-refresh.yaml");
writeFileSync(withoutIt, "timezone: UTC\nhorizon_days: 30\nteams: [Design, Engineering]\n");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let cwd: MockInstance | null = null;
/** Set (or with undefined, unset) environment variables for one test. */
const saved = new Map<string, string | undefined>();
function env(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
/** No config file: the server runs where there's no config/app.yaml. */
function noConfigFile() {
  env({ CONFIG_YAML: undefined, CONFIG_PATH: undefined });
  cwd = vi.spyOn(process, "cwd").mockReturnValue(nowhere);
}
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
  cwd?.mockRestore();
  cwd = null;
});

describe("refresh_minutes (criterion 1)", () => {
  it("is 1 with no config file, with a file without it, and with an inline config without it", () => {
    expect(buildConfig({}).refreshMinutes).toBe(1);
    expect(buildConfig({ timezone: "UTC", horizon_days: 30 }).refreshMinutes).toBe(1);
    expect(loadConfigFile(path.join(dir, "missing.yaml"), false).refreshMinutes).toBe(1);
    expect(loadConfigFile(withoutIt, true).refreshMinutes).toBe(1);

    noConfigFile();
    expect(loadConfig().refreshMinutes).toBe(1);
    env({ CONFIG_PATH: withoutIt });
    expect(loadConfig().refreshMinutes).toBe(1);
    env({ CONFIG_PATH: undefined, CONFIG_YAML: "timezone: UTC\nhorizon_days: 30\n" });
    expect(loadConfig().refreshMinutes).toBe(1);
  });

  it("keeps the value a config sets, from 1 to 1440, and turns down anything else, as before", () => {
    for (const minutes of [1, 2, 9, 10, 15, 60, 1440]) {
      expect(buildConfig({ refresh_minutes: minutes }).refreshMinutes, `${minutes}`).toBe(minutes);
      const file = path.join(dir, `refresh-${minutes}.yaml`);
      writeFileSync(file, `timezone: UTC\nrefresh_minutes: ${minutes}\n`);
      expect(loadConfigFile(file, true).refreshMinutes, `${minutes} in a file`).toBe(minutes);
    }
    for (const wrong of [0, -1, 1441, 2.5, "5"]) {
      expect(() => buildConfig({ refresh_minutes: wrong }), JSON.stringify(wrong)).toThrow(ConfigError);
      expect(() => buildConfig({ refresh_minutes: wrong }), JSON.stringify(wrong)).toThrow(/refresh_minutes/);
    }
  });
});

describe("the scheduler: the next round a minute after one ends (criterion 1)", () => {
  let lines: string[] = [];
  let google: FakeGoogle;
  const t0 = Date.parse("2026-11-21T09:00:00Z");

  beforeEach(() => {
    db.resetAll();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.google-tokens")];
    lines = captureConsole();
    google = fakeGoogle();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A sync module of its own, not started yet, on fake timers from t0. */
  async function freshSync() {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("ekip-takvim.sync")];
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(t0);
    return import("@/lib/server/sync");
  }
  /** Rounds that ran to the end: each logs "sync finished". */
  const rounds = () => lines.filter((l) => l.includes('"msg":"sync finished"')).length;
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  };
  async function after(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  }

  it.each([
    ["an inline config without refresh_minutes", () => env({ CONFIG_YAML: "timezone: UTC\nhorizon_days: 30\n" })],
    ["a config file without it", () => env({ CONFIG_YAML: undefined, CONFIG_PATH: withoutIt })],
    ["no config file", noConfigFile],
  ])("with %s, the next round starts one minute after a round ends, however long that round took", async (_name, config) => {
    config();
    // Ayşe's token request holds the first round for five minutes.
    google.accounts.set("1//refresh-sched", { email: "ayse@example.com", calendars: [{ id: "ayse@example.com" }] });
    db.upsertGoogleUser({ sub: "g-sched", email: "ayse@example.com", name: "Ayşe Demir", timezone: "UTC", refreshToken: secrets.encrypt("1//refresh-sched"), calendarAccess: true });
    const slow = held();
    google.next("1//refresh-sched", slow.plan);

    const sync = await freshSync();
    expect(sync.getConfig()?.refreshMinutes).toBe(1);
    sync.ensureStarted();
    await settle();
    expect(slow.asked()).toBe(true);
    await after(5 * MIN);
    expect(rounds()).toBe(0);
    expect(google.refreshes()).toHaveLength(1);
    slow.release(plans.token(3600));
    await settle();
    expect(rounds()).toBe(1);

    await after(MIN - 1);
    expect(rounds()).toBe(1);
    await after(1);
    expect(rounds()).toBe(2);
    await after(MIN);
    expect(rounds()).toBe(3);
    // Each round read Google: at five minutes (when the first one could), six and seven.
    expect(google.api().filter((c) => c.kind === "list").map((c) => (c.at - t0) / MIN)).toEqual([5, 6, 7]);
  });

  it("when the config doesn't load, the next round is a minute later too; once it loads, its own refresh_minutes applies", async () => {
    env({ CONFIG_YAML: "timezone: Mars/Olympus\n" });
    const sync = await freshSync();
    sync.ensureStarted();
    await settle();
    expect(lines.some((l) => l.includes('"msg":"config error"'))).toBe(true);
    expect(rounds()).toBe(0);

    // Mended while the scheduler waits: the next round loads it.
    env({ CONFIG_YAML: "timezone: UTC\nrefresh_minutes: 5\n" });
    await after(MIN - 1);
    expect(rounds()).toBe(0);
    await after(1);
    expect(rounds()).toBe(1);
    await after(5 * MIN - 1);
    expect(rounds()).toBe(1);
    await after(1);
    expect(rounds()).toBe(2);
  });

  it("a config that sets refresh_minutes keeps it: rounds seven minutes apart", async () => {
    env({ CONFIG_YAML: "timezone: UTC\nrefresh_minutes: 7\n" });
    const sync = await freshSync();
    sync.ensureStarted();
    await settle();
    expect(rounds()).toBe(1);
    await after(MIN);
    expect(rounds()).toBe(1);
    await after(6 * MIN - 1);
    expect(rounds()).toBe(1);
    await after(1);
    expect(rounds()).toBe(2);
    await after(7 * MIN);
    expect(rounds()).toBe(3);
  });
});
