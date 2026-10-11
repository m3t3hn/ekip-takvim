import { describe, expect, it } from "vitest";
import { withAuthuser } from "@/components/event-dialog";

describe("Google links in the event popup", () => {
  it("open Meet and Calendar links in the viewer's account", () => {
    expect(withAuthuser("https://meet.google.com/abc-defg-hij", "omer@example.com")).toBe(
      "https://meet.google.com/abc-defg-hij?authuser=omer%40example.com",
    );
    expect(withAuthuser("https://www.google.com/calendar/event?eid=x", "omer@example.com")).toBe(
      "https://www.google.com/calendar/event?eid=x&authuser=omer%40example.com",
    );
  });

  it("leave other links, and links for signed-out viewers, alone", () => {
    expect(withAuthuser("https://zoom.us/j/1", "omer@example.com")).toBe("https://zoom.us/j/1");
    expect(withAuthuser("https://evilgoogle.com/x", "omer@example.com")).toBe("https://evilgoogle.com/x");
    expect(withAuthuser("https://meet.google.com/abc", null)).toBe("https://meet.google.com/abc");
  });
});
