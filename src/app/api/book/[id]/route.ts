import type { NextRequest } from "next/server";
import { z } from "zod";
import { tryAgainIn } from "@/lib/booking";
import { bookingAllowed } from "@/lib/server/booking-setting";
import { smallJson, visitorAnswer } from "@/lib/server/booking-routes";
import { addressWait, bookTime, createBookingEvent, dropBooking, linkTimes, openLink, syncAfterBusy, takeAddressTry } from "@/lib/server/bookings";
import { clientAddress } from "@/lib/server/rate-limit";
import { isDemo } from "@/lib/server/secrets";
import { appUrl } from "@/lib/server/viewer";
import type { BookingMade, BookingPageInfo } from "@/lib/types";

// A booking link's public side: no sign-in. A visitor sees the host's name,
// the link's title, description and length, whether it's a Google Meet call,
// its free times and which of its days are full: nothing else about the host,
// their calendars or anyone else's bookings.

/** The same for every link that can't be opened, so links can't be probed. */
const gone = () => visitorAnswer({ error: "This booking link doesn't exist or was turned off." }, 404);

/**
 * A try the limit per address refused: how long to wait, in whole minutes
 * rounded up, and Retry-After in whole seconds rounded up, so neither is
 * shorter than the real wait.
 */
const tooManyTries = (waitMs: number) =>
  visitorAnswer({ error: tryAgainIn(waitMs) }, 429, { "Retry-After": String(Math.max(1, Math.ceil(waitMs / 1000))) });

/** The link took 30 bookings in the last hour: its own limit, not the visitor's tries. */
const linkFull = () => visitorAnswer({ error: "This booking link is taking no more bookings for now. Try again in an hour." }, 429);

/** The time isn't offered any more, or Google says it's taken: the page shows what's still free. */
const taken = () => visitorAnswer({ error: "That time was just taken. Pick another." }, 409);

/** The link, its free times right now, and its days that are full. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/book/[id]">) {
  const open = openLink((await ctx.params).id);
  if (!open) return gone();
  const { link, host } = open;
  const { slots, full } = linkTimes(link, host);
  const page: BookingPageInfo = {
    title: link.title,
    description: link.description,
    durationMin: link.duration_min,
    hostName: host.name,
    meet: !!link.meet,
    slots,
    fullDays: full,
  };
  return visitorAnswer(page);
}

const Body = z.object({
  start: z.number(),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().pipe(z.email().max(254)),
  note: z.string().trim().max(500).nullish(),
});

function problemWith(field: PropertyKey | undefined): string {
  switch (field) {
    case "start":
      return "Pick one of the times.";
    case "name":
      return "Give your name, up to 100 characters.";
    case "email":
      return "Give a valid email address.";
    case "note":
      return "Keep the note to 500 characters.";
    default:
      return "Couldn't read that booking.";
  }
}

/**
 * Book a time: { start, name, email, note }. The time has to be one GET would
 * offer at this moment. The answer holds the cancel link, which the page then
 * makes its own address: only its hash is kept. Outside the demo, the answer
 * comes once the host's Google event is made and Google is inviting the
 * visitor (invited).
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/book/[id]">) {
  if (!bookingAllowed()) return gone();
  const { id } = await ctx.params;
  // Every try counts toward its address, whatever it answers (see takeAddressTry).
  const address = clientAddress(request.headers);
  const now = Date.now();
  if (!takeAddressTry(address, now)) return tooManyTries(addressWait(address, now));
  const parsed = Body.safeParse(await smallJson(request));
  if (!parsed.success) return visitorAnswer({ error: problemWith(parsed.error.issues[0]?.path[0]) }, 400);
  const { start, name, email, note } = parsed.data;

  // Nothing is awaited from here until the booking is stored (see bookTime).
  const open = openLink(id);
  if (!open) return gone();
  const made = bookTime(open.link, open.host, { name, email, note: note || null }, start);
  // The link took 30 bookings in the last hour: nothing was stored.
  if (made.outcome === "link full") return linkFull();
  if (made.outcome === "not offered") return taken();

  // Outside the demo the booking is also the host's Google event, and the
  // booking holds the time while it's made. Without the event, nothing of the
  // booking is kept, so it doesn't count toward the link's 30 either. The demo
  // never calls Google.
  const invited = !isDemo();
  if (invited) {
    const event = await createBookingEvent({ ...open, booking: made.booking }).catch(() => "failed" as const);
    if (event !== "made") {
      dropBooking(made.booking.id);
      if (event === "failed") return visitorAnswer({ error: "This booking link can't take bookings right now." }, 503);
      // Google knows of an event the last sync didn't see: read the host's
      // calendars again, so the time stops being offered. Not waited for.
      void syncAfterBusy(open.host.id);
      return taken();
    }
  }
  const answer: BookingMade = {
    start: made.booking.start_ms,
    end: made.booking.end_ms,
    title: made.booking.title,
    hostName: open.host.name,
    cancelUrl: appUrl(request, `/book/cancel/${made.token}`).href,
    invited,
  };
  return visitorAnswer(answer);
}
