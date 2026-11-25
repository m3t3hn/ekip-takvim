import { NextResponse, type NextRequest } from "next/server";
import { hostAnswer, parseLink, problem, signedInHost } from "@/lib/server/booking-routes";
import { MAX_BOOKING_LINKS, addBookingLink } from "@/lib/server/bookings";

/** My booking links, and the bookings people made with me that haven't ended or been cancelled. */
export async function GET() {
  const host = await signedInHost();
  if (host instanceof NextResponse) return host;
  return hostAnswer(host.id);
}

/** Make a booking link; the answer is GET's. */
export async function POST(request: NextRequest) {
  const host = await signedInHost();
  if (host instanceof NextResponse) return host;
  const fields = parseLink(await request.json().catch(() => null));
  if (typeof fields === "string") return problem(400, fields);
  if (!addBookingLink(host.id, fields)) {
    return problem(409, `You can have up to ${MAX_BOOKING_LINKS} booking links. Delete one first.`);
  }
  return hostAnswer(host.id);
}
