import { afterEach, describe, expect, it, vi } from "vitest";
import { busyFromEvent, explain, freeBusy, htmlToText } from "@/lib/server/google";
import { zonedTime } from "@/lib/time";

const timed = (extra: object = {}) => ({
  start: { dateTime: "2026-10-12T10:00:00+03:00" },
  end: { dateTime: "2026-10-12T11:30:00+03:00" },
  ...extra,
});

describe("busy time from Google events", () => {
  it("reads timed events", () => {
    expect(busyFromEvent(timed(), "Europe/Istanbul")).toEqual({
      start: Date.parse("2026-10-12T07:00:00Z"),
      end: Date.parse("2026-10-12T08:30:00Z"),
    });
  });

  it("skips what doesn't block the person", () => {
    expect(busyFromEvent(timed({ status: "cancelled" }), "UTC")).toBeNull();
    expect(busyFromEvent(timed({ transparency: "transparent" }), "UTC")).toBeNull();
    expect(busyFromEvent(timed({ eventType: "workingLocation" }), "UTC")).toBeNull();
    expect(busyFromEvent(timed({ attendees: [{ self: true, responseStatus: "declined" }] }), "UTC")).toBeNull();
  });

  it("marks tentative events and replies", () => {
    expect(busyFromEvent(timed({ status: "tentative" }), "UTC")?.tentative).toBe(true);
    expect(busyFromEvent(timed({ attendees: [{ self: true, responseStatus: "tentative" }] }), "UTC")?.tentative).toBe(true);
    expect(busyFromEvent(timed({ attendees: [{ self: false, responseStatus: "tentative" }] }), "UTC")?.tentative).toBeUndefined();
  });

  it("keeps the title and whether the event is private", () => {
    expect(busyFromEvent(timed({ summary: "  Design review " }), "UTC")?.title).toBe("Design review");
    expect(busyFromEvent(timed({ summary: "Doctor", visibility: "private" }), "UTC")?.private).toBe(true);
    expect(busyFromEvent(timed({ visibility: "confidential" }), "UTC")?.private).toBe(true);
    expect(busyFromEvent(timed({ visibility: "default" }), "UTC")?.private).toBeUndefined();
  });

  it("makes all-day events whole days in the person's zone", () => {
    const b = busyFromEvent({ start: { date: "2026-10-15" }, end: { date: "2026-10-17" } }, "Europe/London");
    expect(b).toEqual({
      start: zonedTime("2026-10-15", 0, "Europe/London"),
      end: zonedTime("2026-10-17", 0, "Europe/London"),
      allDay: true,
    });
  });
});

describe("Google errors", () => {
  it("says what to do, from Google's reason codes only", () => {
    const disabled = { error: { status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured" }], details: [{ reason: "SERVICE_DISABLED" }] } };
    expect(explain(403, disabled)).toMatch(/Calendar API isn't enabled/);
    expect(explain(403, { error: { errors: [{ reason: "insufficientPermissions" }] } })).toMatch(/Sign in again/);
    expect(explain(404, null)).toMatch(/no longer be shared/);
    expect(explain(403, { error: { errors: [{ reason: "forbidden" }] } })).toBe("Google refused access (forbidden)");
  });
});

describe("event details", () => {
  it("keeps the meeting link, place and Google link", () => {
    const b = busyFromEvent(
      timed({ id: "ev1", hangoutLink: "https://meet.google.com/abc", location: "Room 4", htmlLink: "https://www.google.com/calendar/event?eid=x" }),
      "UTC",
    );
    expect(b?.eventId).toBe("ev1");
    expect(b?.details).toEqual({ location: "Room 4", meetLink: "https://meet.google.com/abc", htmlLink: "https://www.google.com/calendar/event?eid=x" });
  });

  it("falls back to a video link added through Calendar, and drops non-web links", () => {
    const zoom = { conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://zoom.us/j/1" }] } };
    expect(busyFromEvent(timed(zoom), "UTC")?.details?.meetLink).toBe("https://zoom.us/j/1");
    expect(busyFromEvent(timed({ hangoutLink: "javascript:alert(1)" }), "UTC")?.details).toBeUndefined();
  });

  it("turns description HTML into plain text, keeping link targets", () => {
    const html = 'Agenda<br>1. <b>Launch</b><br><a href="https://zoom.us/j/9">Join</a> &amp; <a href="https://x.io">https://x.io</a><script>bad()</script>';
    expect(htmlToText(html)).toBe("Agenda\n1. Launch\nJoin (https://zoom.us/j/9) & https://x.io");
  });
});

describe("free/busy calendars", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("are read a month at a time, and a busy time across the seam is joined", async () => {
    const day = 86_400_000;
    const from = Date.parse("2026-09-01T00:00:00Z");
    const to = from + 103 * day; // the sync window: six weeks back, 60 days ahead
    const seam = from + 30 * day;
    const asked: [number, number][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const { timeMin, timeMax } = JSON.parse(String(init.body));
        const [a, b] = [Date.parse(timeMin), Date.parse(timeMax)];
        asked.push([a, b]);
        // One hour each side of the seam: Google cuts it at the edge of each answer.
        const busy = [];
        if (b === seam) busy.push({ start: new Date(seam - 3_600_000).toISOString(), end: new Date(seam).toISOString() });
        if (a === seam) busy.push({ start: new Date(seam).toISOString(), end: new Date(seam + 3_600_000).toISOString() });
        return new Response(JSON.stringify({ calendars: { "me@gmail.com": { busy } } }));
      }),
    );
    const busy = await freeBusy("token", "me@gmail.com", new Date(from), new Date(to));
    expect(asked).toHaveLength(4);
    expect(asked.every(([a, b]) => b - a <= 30 * day)).toBe(true);
    expect([asked[0][0], asked.at(-1)![1]]).toEqual([from, to]);
    expect(busy).toEqual([{ start: seam - 3_600_000, end: seam + 3_600_000 }]);
  });
});
