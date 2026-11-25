import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Booking links' quick wins (run 2026-11-25-ekip-quick-wins-visitor),
// criterion 11: the docs say what the app now does.
// - The user guide's visitor steps.
// - Troubleshooting's message table: every message changed or added here.
// - privacy-and-security.md: the cancel link is the confirmation's address;
//   the title is in the page's HTML, so chat apps that preview the link show
//   the host's name and the link's title; full days.
// The messages are the ones the other tests of this run see on the pages and
// in the answers.

const read = (name: string) => readFileSync(new URL(`../docs/${name}`, import.meta.url), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

/** The visitor's table in troubleshooting.md: the rows after "What visitors of a booking link can be told". */
function visitorTable(): string[] {
  const doc = read("troubleshooting.md");
  const start = doc.indexOf("What visitors of a [booking link]");
  expect(start).toBeGreaterThan(-1);
  const rows: string[] = [];
  for (const line of doc.slice(start).split("\n").slice(1)) {
    if (line.startsWith("|")) rows.push(line);
    else if (rows.length) break;
  }
  return rows;
}
/** A row's message, its first cell. */
const messages = () => visitorTable().map((r) => r.split("|")[1].trim());

describe("troubleshooting's message table for visitors", () => {
  it("lists every message this run added or changed", () => {
    const listed = messages();
    expect(listed).toContain("Fully booked");
    expect(listed.some((m) => /^Too many tries\. Try again in \d+ minutes\.$/.test(m)), listed.join("\n")).toBe(true);
    expect(listed).toContain("This booking link is taking no more bookings for now. Try again in an hour.");
    expect(listed).toContain("This meeting has ended, so it can't be cancelled.");
    expect(listed.some((m) => /^This meeting took place on …$/.test(m))).toBe(true);
    expect(listed.some((m) => /^Google Meet video call/.test(m))).toBe(true);
  });

  it("says what each new row means", () => {
    const row = (start: string) => visitorTable().find((r) => r.split("|")[1].trim().startsWith(start))!;
    expect(row("Fully booked")).toMatch(/bookings-per-day|busy/);
    expect(row("Too many tries")).toMatch(/Retry-After/);
    expect(row("Too many tries")).toMatch(/5 tries in 10 minutes|5 tries/);
    expect(row("This booking link is taking no more bookings")).toMatch(/30 bookings/);
    expect(row("This meeting has ended")).toMatch(/host/);
  });

  it("drops the old wording", () => {
    const doc = read("troubleshooting.md");
    expect(doc).not.toContain("Too many tries. Wait a few minutes and try again.");
    expect(doc).not.toMatch(/shown only (this )?once/i);
  });
});

describe("the user guide's visitor steps", () => {
  const guide = () => {
    const doc = read("user-guide.md");
    const start = doc.indexOf("**What visitors see and do:**");
    expect(start).toBeGreaterThan(-1);
    return flat(doc.slice(start, doc.indexOf("**What a booking makes:**", start)));
  };

  it("say the page names the zone with its offset and follows the visitor's 12- or 24-hour clock", () => {
    expect(guide()).toMatch(/Istanbul time \(GMT\+3\)/);
    expect(guide()).toMatch(/4:00 pm/);
    expect(guide()).toMatch(/16:00/);
  });

  it("say a Meet link shows on the page and the confirmation", () => {
    expect(guide()).toMatch(/Google Meet video call/);
  });

  it("say full days are listed as Fully booked, and no days when nothing is free", () => {
    expect(guide()).toMatch(/Fully booked/);
    expect(guide()).toMatch(/no free times/i);
  });

  it("say the confirmation's address is the cancel link, what opening it shows, and Book another time", () => {
    expect(guide()).toMatch(/address is now the booking's cancel link|address.*cancel link/i);
    expect(guide()).toMatch(/bookmark/i);
    expect(guide()).toMatch(/You're booked/);
    expect(guide()).toMatch(/took place/);
    expect(guide()).toMatch(/Book another time/);
    expect(guide()).not.toMatch(/shown only once|shown only this once/i);
  });

  it("say Book waits, with the minutes, after too many tries", () => {
    expect(guide()).toMatch(/5 tries in 10 minutes/);
    expect(guide()).toMatch(/minutes/);
  });

  it("say a meeting that took place can't be cancelled", () => {
    const doc = flat(read("user-guide.md"));
    expect(doc).toMatch(/Once its meeting has ended, a booking can't be cancelled/);
  });
});

describe("privacy-and-security.md", () => {
  const doc = () => flat(read("privacy-and-security.md"));

  it("says the cancel link is the confirmation's address, kept out of Referer headers", () => {
    expect(doc()).toMatch(/confirmation's own address becomes the booking's cancel link/);
    expect(doc()).toMatch(/Referrer-Policy: no-referrer/);
    expect(doc()).not.toMatch(/cancel link, shown once/);
  });

  it("says the title is in the page's HTML, so chat apps' previews show the host's name and the link's title", () => {
    expect(doc()).toMatch(/title\*\* is in its HTML|title is in (its|the page's) HTML/);
    expect(doc()).toMatch(/Slack/);
    expect(doc()).toMatch(/WhatsApp/);
    expect(doc()).toMatch(/Teams/);
    expect(doc()).toMatch(/host's name and the link's title/);
    expect(doc()).toMatch(/Book a time · Ekip Takvim/);
  });

  it("says full days are shown, and what that tells visitors", () => {
    expect(doc()).toMatch(/Full days/);
    expect(doc()).toMatch(/Fully booked/);
    expect(doc()).toMatch(/but not why/);
  });
});
