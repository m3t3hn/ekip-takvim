import { NextResponse, type NextRequest } from "next/server";
import { BEING_MADE, CANT_CANCEL, ENDED, hostAnswer, problem, signedInHost } from "@/lib/server/booking-routes";
import { cancelBooking, ownBooking } from "@/lib/server/bookings";

/**
 * Cancel a booking someone made with me: its time is free again, and outside
 * the demo its Google event is deleted, so Google tells the visitor. Once its
 * meeting has ended, 409, and Google isn't asked; while its event is still
 * being made, 409 too; when Google can't delete it, 503: in each case the
 * booking stays. One cancelled already stays as it was. The answer is GET
 * /api/me/booking-links's.
 */
export async function POST(_request: NextRequest, ctx: RouteContext<"/api/me/bookings/[id]/cancel">) {
  const host = await signedInHost();
  if (host instanceof NextResponse) return host;
  const { id } = await ctx.params;
  const booking = ownBooking(host.id, id);
  if (!booking) return problem(404, "No such booking");
  const result = await cancelBooking(booking);
  if (result === "ended") return problem(409, ENDED);
  if (result === "being made") return problem(409, BEING_MADE);
  if (result === "failed") return problem(503, CANT_CANCEL);
  return hostAnswer(host.id);
}
