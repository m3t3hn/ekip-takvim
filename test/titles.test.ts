import { describe, expect, it } from "vitest";

process.env.DATABASE_PATH = ":memory:";
const { mayShowTitle } = await import("@/lib/server/sync");

describe("who sees event titles", () => {
  it("shows people all their own titles, on any calendar, private or not", () => {
    expect(mayShowTitle("elif", "elif", false, false)).toBe(true);
    expect(mayShowTitle("elif", "elif", true, true)).toBe(true);
  });

  it("shows signed-in colleagues company-calendar titles, except private events", () => {
    expect(mayShowTitle("mert", "elif", true, false)).toBe(true);
    expect(mayShowTitle("mert", "elif", true, true)).toBe(false);
  });

  it("never shows others the titles on personal calendars", () => {
    expect(mayShowTitle("mert", "elif", false, false)).toBe(false);
  });

  it("shows nothing to someone who isn't signed in", () => {
    expect(mayShowTitle(null, "elif", true, false)).toBe(false);
  });
});
