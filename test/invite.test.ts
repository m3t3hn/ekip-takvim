import { describe, expect, it } from "vitest";
import { buildIcs, googleCalendarUrl, outlookUrl, type InviteDraft } from "@/lib/invite";

const draft: InviteDraft = {
  title: "Team sync; plans, budget",
  start: Date.parse("2026-10-07T15:00:00Z"),
  end: Date.parse("2026-10-07T16:00:00Z"),
  note: "Agenda:\n1. Launch",
  location: "Zoom",
  attendees: [
    { name: "Ahmet Yılmaz", email: "ahmet@example.com" },
    { name: "Elif, Kaya", email: "elif@example.com" },
  ],
};

describe("invite links", () => {
  it("prefills Google Calendar with time and guests", () => {
    const url = new URL(googleCalendarUrl(draft));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe("20261007T150000Z/20261007T160000Z");
    expect(url.searchParams.get("add")).toBe("ahmet@example.com,elif@example.com");
    expect(url.searchParams.get("text")).toBe(draft.title);
    expect(url.searchParams.has("authuser")).toBe(false);
  });

  it("opens the organiser's own Google account", () => {
    const url = new URL(googleCalendarUrl(draft, "omer@example.com"));
    expect(url.searchParams.get("authuser")).toBe("omer@example.com");
  });

  it("prefills Outlook for work and personal accounts", () => {
    const work = new URL(outlookUrl(draft, "work"));
    expect(work.host).toBe("outlook.office.com");
    expect(work.searchParams.get("startdt")).toBe("2026-10-07T15:00:00Z");
    expect(work.searchParams.get("enddt")).toBe("2026-10-07T16:00:00Z");
    expect(new URL(outlookUrl(draft, "personal")).host).toBe("outlook.live.com");
  });
});

describe("invite .ics", () => {
  const ics = buildIcs(draft, "abc", Date.parse("2026-10-07T10:00:00Z"));

  it("is valid iCal with escaped text and CRLF lines", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20261007T150000Z\r\n");
    expect(ics).toContain("SUMMARY:Team sync\\; plans\\, budget\r\n");
    expect(ics).toContain("DESCRIPTION:Agenda:\\n1. Launch\r\n");
    expect(ics).toContain('CN="Elif, Kaya"');
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
  });
});
