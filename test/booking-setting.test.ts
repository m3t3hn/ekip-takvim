import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Booking links, criterion 1: BOOKING_LINKS. "on" (trimmed, any case) turns
// booking links on; unset, empty or "off" leaves them off; anything else acts
// as off and is reported in the start-up log. The start-up log's access line
// says whether booking pages are public. ensureStarted() logs once per
// process, so each case clears its started flag (the sync state on globalThis).
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "s".repeat(40);
process.env.CONFIG_YAML = "timezone: UTC\n";
delete process.env.DEMO_MODE;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.BOOKING_LINKS;
delete process.env.CALENDAR_LINKS;

const { bookingAllowed } = await import("@/lib/server/booking-setting");
const sync = await import("@/lib/server/sync");
const STATE = Symbol.for("ekip-takvim.sync");
const logged: { method: string; text: string }[] = [];

function set(value: string | undefined) {
  if (value === undefined) delete process.env.BOOKING_LINKS;
  else process.env.BOOKING_LINKS = value;
}

/** Start as the server does with this BOOKING_LINKS: the access line, and the lines naming BOOKING_LINKS. */
function start(value: string | undefined) {
  set(value);
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
  expect(starting, String(value)).toHaveLength(1);
  return {
    access: String(starting[0].access),
    errors: logged.filter((l) => l.method === "error" && l.text.includes("BOOKING_LINKS")),
    warnings: logged.filter((l) => l.method === "warn" && l.text.includes("BOOKING_LINKS")),
  };
}

beforeAll(() => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push({ method, text: args.map(String).join(" ") });
    });
  }
});
afterEach(() => {
  delete process.env.BOOKING_LINKS;
});

describe("bookingAllowed()", () => {
  it("is true for on, trimmed and in any case", () => {
    for (const value of ["on", "ON", "On", " ON ", "\ton\n"]) {
      set(value);
      expect(bookingAllowed(), JSON.stringify(value)).toBe(true);
    }
  });

  it("is false when unset, empty or off", () => {
    for (const value of [undefined, "", "   ", "off", "OFF", " Off "]) {
      set(value);
      expect(bookingAllowed(), JSON.stringify(value)).toBe(false);
    }
  });

  it("is false for any other value", () => {
    for (const value of ["yes", "true", "1", "enabled", "public", "onn", "o n", "on off"]) {
      set(value);
      expect(bookingAllowed(), value).toBe(false);
    }
  });
});

describe("BOOKING_LINKS in the start-up log", () => {
  it("has an error line naming BOOKING_LINKS for a value that isn't on or off", () => {
    for (const value of ["yes", "true", "1", "public", "onn"]) {
      const run = start(value);
      expect(run.errors, value).toHaveLength(1);
    }
  });

  it("has no such line for on, off, empty or unset", () => {
    for (const value of [undefined, "", "on", " ON ", "off", "OFF"]) {
      const run = start(value);
      expect([...run.errors, ...run.warnings], JSON.stringify(value)).toEqual([]);
    }
  });

  it("says in the access line whether booking pages are public", () => {
    const on = start("on").access;
    const off = start("off").access;
    expect(on).not.toBe(off);
    // The access line is "; "-separated: the part about booking pages.
    const booking = (access: string) => access.split(";").filter((part) => /book/i.test(part)).join(";");
    expect(booking(on)).toMatch(/public/i);
    expect(booking(off)).not.toMatch(/public/i);
    // Unset, empty and anything else read as off; " ON " as on.
    for (const value of [undefined, "", "yes"]) expect(start(value).access, JSON.stringify(value)).toBe(off);
    expect(start(" ON ").access).toBe(on);
  });
});
