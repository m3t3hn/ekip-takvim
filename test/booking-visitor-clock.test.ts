import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prefersHour12, timeLabel, zoneName } from "@/app/book/clock";
import { BookingForm, Confirmation, TimeList } from "@/app/book/[id]/booking-page";
import { BookingStatus } from "@/app/book/cancel/[token]/cancel-page";
import { formatRange, formatTime } from "@/lib/time";
import type { BookingMade, BookingToCancel } from "@/lib/types";
import { at } from "./booking-reference";
import { all, byTag, one, render, textOf } from "./booking-html";

// Booking links' quick wins (run 2026-11-25-ekip-quick-wins-visitor):
// - criterion 4: wherever the visitor pages name the zone, it reads like
//   "Istanbul time (GMT+3)" or "New York time (GMT−5)", with the offset at the
//   time shown (the list's first time); UTC reads "UTC", Etc/GMT-3 "GMT+3".
//   Times follow the visitor's 12- or 24-hour preference from the browser's
//   locale ("4:00 pm" for en-US, "16:00" for en-GB or tr-TR); dates and words
//   stay English; the rest of the app is unchanged.
// - criterion 8, the names: each time button's accessible name has its day
//   and time, on the visitor's clock; a full day says it's fully booked.
// The pure helpers are called directly; the views are rendered with
// react-dom/server.

const MINUS = "−";
const IST = "Europe/Istanbul";
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const ist = (d: number, h: number, m = 0) => at(IST, 2026, 11, d, h, m);
const MIN = 60_000;
const WINTER = Date.UTC(2026, 0, 15, 12);
const SUMMER = Date.UTC(2026, 6, 15, 12);

describe("zone names (criterion 4)", () => {
  it("names a zone by its city, with the offset in effect then", () => {
    expect(zoneName(IST, WINTER)).toBe("Istanbul time (GMT+3)");
    expect(zoneName(IST, SUMMER)).toBe("Istanbul time (GMT+3)");
    expect(zoneName(NY, WINTER)).toBe(`New York time (GMT${MINUS}5)`);
    expect(zoneName(NY, SUMMER)).toBe(`New York time (GMT${MINUS}4)`);
    expect(zoneName(LA, Date.UTC(2026, 10, 30))).toBe(`Los Angeles time (GMT${MINUS}8)`);
    expect(zoneName("Europe/Berlin", SUMMER)).toBe("Berlin time (GMT+2)");
    expect(zoneName("Asia/Tokyo", WINTER)).toBe("Tokyo time (GMT+9)");
    expect(zoneName("Pacific/Kiritimati", WINTER)).toBe("Kiritimati time (GMT+14)");
    expect(zoneName("Pacific/Pago_Pago", WINTER)).toBe(`Pago Pago time (GMT${MINUS}11)`);
  });

  it("takes the zone's last part, with spaces for underscores", () => {
    expect(zoneName("America/Argentina/Buenos_Aires", WINTER)).toBe(`Buenos Aires time (GMT${MINUS}3)`);
    expect(zoneName("America/Port_of_Spain", WINTER)).toBe(`Port of Spain time (GMT${MINUS}4)`);
    expect(zoneName("America/North_Dakota/New_Salem", WINTER)).toBe(`New Salem time (GMT${MINUS}6)`);
    expect(zoneName("America/St_Johns", WINTER)).toBe(`St Johns time (GMT${MINUS}3:30)`);
  });

  it("writes offsets that aren't whole hours with their minutes", () => {
    expect(zoneName("Asia/Kolkata", WINTER)).toBe("Kolkata time (GMT+5:30)");
    expect(zoneName("Asia/Kathmandu", WINTER)).toBe("Kathmandu time (GMT+5:45)");
    expect(zoneName("Pacific/Chatham", WINTER)).toBe("Chatham time (GMT+13:45)");
  });

  it("follows the clock change: the offset at the time shown", () => {
    // Berlin's summer time ends at 01:00 UTC on 25 Oct 2026.
    expect(zoneName("Europe/Berlin", Date.UTC(2026, 9, 25, 0, 59))).toBe("Berlin time (GMT+2)");
    expect(zoneName("Europe/Berlin", Date.UTC(2026, 9, 25, 1, 0))).toBe("Berlin time (GMT+1)");
    // New York's ends at 06:00 UTC on 1 Nov 2026.
    expect(zoneName(NY, Date.UTC(2026, 10, 1, 5, 59))).toBe(`New York time (GMT${MINUS}4)`);
    expect(zoneName(NY, Date.UTC(2026, 10, 1, 6, 0))).toBe(`New York time (GMT${MINUS}5)`);
    expect(zoneName("Europe/London", SUMMER)).toBe("London time (GMT+1)");
    // London in winter is at no offset: GMT, however it's written.
    expect(zoneName("Europe/London", WINTER)).toMatch(/^London time \(GMT(\+0)?\)$/);
  });

  it("reads UTC as 'UTC', and an Etc/GMT zone as its real offset", () => {
    expect(zoneName("UTC", WINTER)).toBe("UTC");
    expect(zoneName("Etc/GMT-3", WINTER)).toBe("GMT+3");
    expect(zoneName("Etc/GMT+5", WINTER)).toBe(`GMT${MINUS}5`);
    expect(zoneName("Etc/GMT-14", WINTER)).toBe("GMT+14");
    expect(zoneName("Etc/GMT+12", WINTER)).toBe(`GMT${MINUS}12`);
    // UTC by other names: no city, no offset to speak of.
    for (const zone of ["Etc/UTC", "Etc/GMT", "GMT"]) expect(zoneName(zone, WINTER), zone).toMatch(/^(UTC|GMT|GMT\+0)$/);
  });
});

describe("the visitor's 12- or 24-hour clock (criterion 4)", () => {
  it("reads the preference from the locale: en-US 12-hour, en-GB and tr-TR 24-hour", () => {
    expect(prefersHour12("en-US")).toBe(true);
    expect(prefersHour12("en-GB")).toBe(false);
    expect(prefersHour12("tr-TR")).toBe(false);
  });

  it("writes '4:00 pm' on a 12-hour clock and '16:00' on a 24-hour one", () => {
    const four = ist(30, 16);
    expect(timeLabel(four, { zone: IST, hour12: true })).toBe("4:00 pm");
    expect(timeLabel(four, { zone: IST, hour12: false })).toBe("16:00");
    expect(timeLabel(ist(30, 0), { zone: IST, hour12: true })).toBe("12:00 am");
    expect(timeLabel(ist(30, 0, 30), { zone: IST, hour12: false })).toBe("00:30");
    expect(timeLabel(ist(30, 12), { zone: IST, hour12: true })).toBe("12:00 pm");
    expect(timeLabel(ist(30, 9, 5), { zone: IST, hour12: true })).toBe("9:05 am");
    expect(timeLabel(ist(30, 9, 5), { zone: IST, hour12: false })).toBe("09:05");
    // On the visitor's own clock: 16:00 in Istanbul is 8:00 am in New York.
    expect(timeLabel(four, { zone: NY, hour12: true })).toBe("8:00 am");
  });

  it("leaves the rest of the app's times as they were", () => {
    expect(formatTime(ist(30, 16), IST)).toBe("16:00");
    expect(formatRange(ist(30, 16), ist(30, 16, 30), IST)).toBe("16:00–16:30");
    expect(formatRange(ist(30, 23), ist(31, 0), IST)).toBe("23:00–24:00");
  });
});

// Monday 30 November 2026 in Istanbul: 10:00, 16:00 and 16:30.
const SLOTS = [ist(30, 10), ist(30, 16), ist(30, 16, 30)].map((start) => ({ start, end: start + 30 * MIN }));
const listProps = (clock: { zone: string; hour12: boolean }, slots = SLOTS, fullDays: number[] = []) => ({
  slots,
  fullDays,
  clock,
  at: slots[0]?.start ?? ist(25, 12),
  problem: null,
  focus: false,
  onPick: () => {},
});
const formProps = (clock: { zone: string; hour12: boolean }, slot = SLOTS[1]) => ({
  slot,
  clock,
  guest: { name: "", email: "", note: "" },
  problem: null,
  wait: null,
  sending: false,
  canBook: false,
  onField: () => {},
  onBack: () => {},
  onSubmit: () => {},
});
const made = (start: number): BookingMade => ({
  start,
  end: start + 30 * MIN,
  title: "Intro call",
  hostName: "Zeynep Şahin",
  cancelUrl: "https://cal.example.com/book/cancel/tok3n",
  invited: true,
});
const booking = (start: number, more: Partial<BookingToCancel> = {}): BookingToCancel => ({
  title: "Intro call",
  start,
  end: start + 30 * MIN,
  hostName: "Zeynep Şahin",
  cancelled: false,
  ended: false,
  bookAgain: null,
  ...more,
});
const statusProps = (b: BookingToCancel, clock: { zone: string; hour12: boolean }) => ({
  booking: b,
  clock,
  address: "https://cal.example.com/book/cancel/tok3n",
  busy: false,
  problem: null,
  focusCancelled: false,
  onCancel: () => {},
});
const GB = { zone: IST, hour12: false };
const US = { zone: IST, hour12: true };

describe("the visitor pages name the zone readably, at the time shown (criterion 4)", () => {
  // "Now" is in January (EST, UTC-5): the times shown are in summer time (EDT, UTC-4) where it matters,
  // so an offset read at the wrong moment shows.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the time list: at its first time", () => {
    // A visitor in New York, with times on 31 Oct (EDT, UTC-4) and 2 Nov (EST, UTC-5).
    const slots = [Date.UTC(2026, 9, 31, 14), Date.UTC(2026, 10, 2, 15)].map((start) => ({ start, end: start + 30 * MIN }));
    const { text } = render(TimeList, listProps({ zone: NY, hour12: true }, slots));
    expect(text).toContain(`New York time (GMT${MINUS}4)`);
    expect(text).not.toContain(`GMT${MINUS}5`);
    expect(text).not.toContain("America/New_York");
    // With no time to show, at the time it was given (when the page loaded).
    const none = render(TimeList, { ...listProps({ zone: NY, hour12: true }, []), at: Date.UTC(2026, 6, 1) });
    expect(none.text).toContain(`New York time (GMT${MINUS}4)`);
  });

  it("the form: at the picked time", () => {
    const { text } = render(BookingForm, formProps({ zone: NY, hour12: true }, { start: Date.UTC(2026, 6, 2, 15), end: Date.UTC(2026, 6, 2, 15, 30) }));
    expect(text).toContain(`New York time (GMT${MINUS}4)`);
    expect(text).not.toContain("America/New_York");
  });

  it("the confirmation: at the booked time", () => {
    const { text } = render(Confirmation, { made: made(Date.UTC(2026, 9, 31, 14)), email: "ayse@example.org", meet: false, clock: { zone: NY, hour12: true } });
    expect(text).toContain(`New York time (GMT${MINUS}4)`);
    expect(text).not.toContain("America/New_York");
  });

  it("the cancel page, booked, cancelled and taken place: at the booked time", () => {
    for (const more of [{}, { cancelled: true }, { ended: true }]) {
      const { text } = render(BookingStatus, statusProps(booking(Date.UTC(2026, 10, 2, 15), more), { zone: "Etc/GMT-3", hour12: false }));
      expect(text, JSON.stringify(more)).toContain("GMT+3");
      expect(text, JSON.stringify(more)).not.toContain("Etc/GMT");
    }
    const utc = render(BookingStatus, statusProps(booking(Date.UTC(2026, 10, 2, 15)), { zone: "UTC", hour12: false }));
    expect(utc.text).toContain("UTC");
    for (const more of [{}, { cancelled: true }, { ended: true }]) {
      const ny = render(BookingStatus, statusProps(booking(Date.UTC(2026, 6, 2, 15), more), { zone: NY, hour12: true }));
      expect(ny.text, JSON.stringify(more)).toContain(`New York time (GMT${MINUS}4)`);
    }
  });
});

describe("times on the visitor's clock, words in English (criterion 4)", () => {
  it("the time buttons read '4:00 pm' on a 12-hour clock and '16:00' on a 24-hour one, under English day names", () => {
    const us = render(TimeList, listProps(US));
    expect(byTag(us.root, "button").map(textOf)).toEqual(["10:00 am", "4:00 pm", "4:30 pm"]);
    expect(byTag(us.root, "h3").map(textOf)).toEqual(["Monday 30 November"]);
    const gb = render(TimeList, listProps(GB));
    expect(byTag(gb.root, "button").map(textOf)).toEqual(["10:00", "16:00", "16:30"]);
    expect(byTag(gb.root, "h3").map(textOf)).toEqual(["Monday 30 November"]);
    expect(gb.text).toContain("Pick a time");
  });

  it("the form, the confirmation and the cancel page follow it too", () => {
    const form = (clock: typeof US) => textOf(byTag(render(BookingForm, formProps(clock)).root, "h2")[0]);
    expect(form(US)).toContain("Monday 30 November");
    expect(form(US)).toMatch(/4:00 pm.*4:30 pm/);
    expect(form(US)).not.toContain("16:");
    expect(form(GB)).toMatch(/16:00.*16:30/);
    expect(form(GB)).not.toMatch(/\b(am|pm)\b/);

    const confirmation = (clock: typeof US) => render(Confirmation, { made: made(ist(30, 16)), email: "a@example.org", meet: false, clock }).text;
    expect(confirmation(US)).toMatch(/Monday 30 November.*4:00 pm.*4:30 pm/);
    expect(confirmation(GB)).toMatch(/Monday 30 November.*16:00.*16:30/);

    for (const more of [{}, { cancelled: true }, { ended: true }]) {
      const status = (clock: typeof US) => render(BookingStatus, statusProps(booking(ist(30, 16), more), clock)).text;
      expect(status(US), JSON.stringify(more)).toMatch(/Monday 30 November.*4:00 pm.*4:30 pm/);
      expect(status(GB), JSON.stringify(more)).toMatch(/Monday 30 November.*16:00.*16:30/);
    }
  });
});

describe("screen readers: each time button's name has its day and time (criterion 8)", () => {
  it("names each button 'Monday 30 November, 16:00' on a 24-hour clock, '…, 4:00 pm' on a 12-hour one", () => {
    const names = (clock: typeof US) => byTag(render(TimeList, listProps(clock)).root, "button").map((b) => b.attrs["aria-label"]);
    expect(names(GB)).toEqual(["Monday 30 November, 10:00", "Monday 30 November, 16:00", "Monday 30 November, 16:30"]);
    expect(names(US)).toEqual(["Monday 30 November, 10:00 am", "Monday 30 November, 4:00 pm", "Monday 30 November, 4:30 pm"]);
  });

  it("names them on the visitor's clock: 10:00 on Monday in Istanbul is Sunday 11:00 pm in Los Angeles", () => {
    const { root } = render(TimeList, listProps({ zone: LA, hour12: true }));
    expect(byTag(root, "button").map((b) => b.attrs["aria-label"])).toEqual([
      "Sunday 29 November, 11:00 pm",
      "Monday 30 November, 5:00 am",
      "Monday 30 November, 5:30 am",
    ]);
  });

  it("gives the same time on three days three names", () => {
    const slots = [ist(30, 16), at(IST, 2026, 12, 1, 16), at(IST, 2026, 12, 2, 16)].map((start) => ({ start, end: start + 30 * MIN }));
    const buttons = byTag(render(TimeList, listProps(GB, slots)).root, "button");
    expect(buttons.map(textOf)).toEqual(["16:00", "16:00", "16:00"]);
    expect(buttons.map((b) => b.attrs["aria-label"])).toEqual(["Monday 30 November, 16:00", "Tuesday 1 December, 16:00", "Wednesday 2 December, 16:00"]);
  });

  it("says a full day is fully booked, under the day's name", () => {
    const { root } = render(TimeList, listProps(GB, SLOTS, [ist(26, 10)]));
    const heading = one(root, (e) => e.tag === "h3" && textOf(e) === "Thursday 26 November", "Thursday's heading");
    const block = all(root, (e) => e.children.includes(heading))[0];
    expect(textOf(block)).toBe("Thursday 26 November Fully booked");
    expect(byTag(block, "button")).toEqual([]);
  });
});
