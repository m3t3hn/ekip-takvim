import type { NextRequest } from "next/server";
import { BEING_MADE, CANT_CANCEL, ENDED, visitorAnswer } from "@/lib/server/booking-routes";
import { bookAgainPath, bookingByToken, cancelBooking, hasEnded, type BookingRow } from "@/lib/server/bookings";
import type { BookingToCancel } from "@/lib/types";

// A booking's cancel link, which is also its confirmation's address: whoever
// has it can see the booking's title, time and host, and cancel it until its
// meeting ends. No sign-in; nothing about the guest comes back.

const notFound = () => visitorAnswer({ error: "No booking matches this cancel link." }, 404);

function shown(b: BookingRow & { host_name: string }, now = Date.now()): BookingToCancel {
  const cancelled = b.cancelled_at !== null;
  const ended = hasEnded(b, now);
  return {
    title: b.title,
    start: b.start_ms,
    end: b.end_ms,
    hostName: b.host_name,
    cancelled,
    ended,
    // Only where the page offers to book another time.
    bookAgain: cancelled || ended ? bookAgainPath(b) : null,
  };
}

export async function GET(_request: NextRequest, ctx: RouteContext<"/api/book/cancel/[token]">) {
  const booking = bookingByToken((await ctx.params).token);
  return booking ? visitorAnswer(shown(booking)) : notFound();
}

/**
 * Cancel the booking: its time is free again, and outside the demo its Google
 * event is deleted, so Google tells the visitor. Once its meeting has ended,
 * 409, and Google isn't asked; while its event is still being made, 409 too;
 * when Google can't delete it, 503: in each case the booking stays. One
 * cancelled already stays as it was.
 */
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/book/cancel/[token]">) {
  const booking = bookingByToken((await ctx.params).token);
  if (!booking) return notFound();
  const result = await cancelBooking(booking);
  if (result === "ended") return visitorAnswer({ error: ENDED }, 409);
  if (result === "being made") return visitorAnswer({ error: BEING_MADE }, 409);
  if (result === "failed") return visitorAnswer({ error: CANT_CANCEL }, 503);
  return visitorAnswer(shown({ ...booking, cancelled_at: booking.cancelled_at ?? Date.now() }));
}
