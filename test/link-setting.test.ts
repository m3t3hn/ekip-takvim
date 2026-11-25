import { beforeAll, describe, expect, it, vi } from "vitest";

// CALENDAR_LINKS in the start-up log (criterion 11, dispatch point 3): the
// access checks say where calendar links may go, and a value that isn't on,
// private or off is reported. ensureStarted() logs once per process, so each
// case clears its started flag (the sync state on globalThis) first.
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "l".repeat(40);
process.env.CONFIG_YAML = "timezone: UTC\n";
delete process.env.DEMO_MODE;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.CALENDAR_LINKS;

const sync = await import("@/lib/server/sync");
const STATE = Symbol.for("ekip-takvim.sync");
const logged: { method: string; text: string }[] = [];

function start(setting: string | undefined) {
  if (setting === undefined) delete process.env.CALENDAR_LINKS;
  else process.env.CALENDAR_LINKS = setting;
  (globalThis as unknown as Record<symbol, { started: boolean }>)[STATE].started = false;
  logged.length = 0;
  sync.ensureStarted();
  const starting = logged.flatMap(({ text }) => {
    try {
      const line = JSON.parse(text) as { msg?: string; access?: unknown };
      return line.msg === "starting" ? [line] : [];
    } catch {
      return [];
    }
  });
  expect(starting, String(setting)).toHaveLength(1);
  return {
    access: String(starting[0].access),
    problems: logged.filter((l) => (l.method === "warn" || l.method === "error") && l.text.includes("CALENDAR_LINKS")),
  };
}

beforeAll(() => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push({ method, text: args.map(String).join(" ") });
    });
  }
});

describe("CALENDAR_LINKS in the start-up log", () => {
  it("is listed in the access checks for each value", () => {
    const unset = start(undefined);
    const on = start("on");
    const priv = start("private");
    const off = start("off");
    for (const [name, run] of Object.entries({ unset, on, priv, off })) {
      expect(run.access, name).toMatch(/calendar link/i);
      expect(run.problems, name).toEqual([]);
    }
    expect(on.access).toBe(unset.access);
    expect(priv.access).not.toBe(on.access);
    expect(off.access).not.toBe(on.access);
    expect(off.access).not.toBe(priv.access);
    expect(off.access).toMatch(/\boff\b/i);
    expect(on.access).not.toMatch(/\boff\b/i);
    expect(priv.access).not.toMatch(/\boff\b/i);
  });

  it("reports a value that isn't on, private or off, and says links are off", () => {
    for (const value of ["yes", "public", "1", "of"]) {
      const run = start(value);
      expect(run.problems, value).not.toEqual([]);
      expect(run.access, value).toMatch(/calendar link/i);
      expect(run.access, value).toMatch(/\boff\b/i);
    }
  });

  it("takes the value as EXPOSURE is taken: trimmed, in any case", () => {
    const on = start("on").access;
    const priv = start("private").access;
    const off = start("off").access;
    expect(new Set([on, priv, off]).size).toBe(3);
    for (const [value, as] of [
      [" Private ", priv],
      ["PRIVATE", priv],
      ["OFF", off],
      [" off\n", off],
      [" on ", on],
      ["On", on],
      ["", on],
    ] as const) {
      const run = start(value);
      expect(run.access, JSON.stringify(value)).toBe(as);
      // A value read as invalid would be reported.
      expect(run.problems, JSON.stringify(value)).toEqual([]);
    }
  });
});
