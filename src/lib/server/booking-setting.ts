// Booking links, from BOOKING_LINKS. A signed-in person makes a link that
// anyone can open, without signing in, to book a time with them. Those pages
// are public, so an install turns them on deliberately:
// - on: booking links work, and /book/... and /api/book/... pass the app's own
//   access checks (see proxy.ts);
// - off (the default): no booking links, and those paths are checked like any other.
// Any other value acts as off, and the start-up log says so.

export type BookingSetting = "on" | "off";

/** The BOOKING_LINKS setting; anything but the two values is "invalid", which acts as off. */
export function bookingSetting(): BookingSetting | "invalid" {
  const value = (process.env.BOOKING_LINKS ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return "off";
  if (value === "on") return "on";
  return "invalid";
}

/** Whether this server takes booking links, and serves their public pages. */
export function bookingAllowed(): boolean {
  return bookingSetting() === "on";
}

/** Whether booking pages are public, for the start-up log's access line. */
export function bookingCheck(): string {
  return bookingAllowed()
    ? "booking pages public: /book/ and /api/book/ skip these checks (BOOKING_LINKS=on)"
    : "no booking pages";
}
