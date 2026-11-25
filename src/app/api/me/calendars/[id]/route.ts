import { NextResponse, type NextRequest } from "next/server";
import { getUser, removeLinkCalendar } from "@/lib/server/db";
import { mySettings } from "@/lib/server/me";
import { sessionUserId } from "@/lib/server/viewer";

/** Remove one of my calendar links, with its busy times; the answer is my settings. Google calendars aren't removed here. */
export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/me/calendars/[id]">) {
  const id = await sessionUserId();
  if (!id || !getUser(id)) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const { id: calendarId } = await ctx.params;
  if (!removeLinkCalendar(id, calendarId)) return NextResponse.json({ error: "No such calendar link" }, { status: 404 });
  return NextResponse.json(mySettings(id), { headers: { "Cache-Control": "no-store" } });
}
