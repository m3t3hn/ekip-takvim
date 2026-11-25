import { NextResponse, type NextRequest } from "next/server";
import { hostAnswer, parseLink, problem, signedInHost } from "@/lib/server/booking-routes";
import { deleteBookingLink, linkFields, ownLink, updateBookingLink } from "@/lib/server/bookings";

const NOT_FOUND = "No such booking link";

/** Change one of my booking links, or turn it on or off (active); what the body leaves out stays. The answer is GET's. */
export async function PUT(request: NextRequest, ctx: RouteContext<"/api/me/booking-links/[id]">) {
  const host = await signedInHost();
  if (host instanceof NextResponse) return host;
  const { id } = await ctx.params;
  const link = ownLink(host.id, id);
  if (!link) return problem(404, NOT_FOUND);
  const fields = parseLink(await request.json().catch(() => null), linkFields(link));
  if (typeof fields === "string") return problem(400, fields);
  if (!updateBookingLink(host.id, id, fields)) return problem(404, NOT_FOUND);
  return hostAnswer(host.id);
}

/** Delete one of my booking links: its page stops working, and its bookings stay. The answer is GET's. */
export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/me/booking-links/[id]">) {
  const host = await signedInHost();
  if (host instanceof NextResponse) return host;
  const { id } = await ctx.params;
  if (!deleteBookingLink(host.id, id)) return problem(404, NOT_FOUND);
  return hostAnswer(host.id);
}
