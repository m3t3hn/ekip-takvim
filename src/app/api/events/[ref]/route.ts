import { NextResponse, type NextRequest } from "next/server";
import { getEventByRef } from "@/lib/server/db";
import { mayShowTitle } from "@/lib/server/sync";
import { currentViewer } from "@/lib/server/viewer";
import type { EventInfo } from "@/lib/types";

/** One event's details, for someone allowed to see its title (same rule as the calendar). */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/events/[ref]">) {
  const { ref } = await ctx.params;
  const viewer = await currentViewer();
  const e = getEventByRef(ref);
  // Not found and not allowed look the same, so refs can't be probed.
  if (!e || !e.title || !mayShowTitle(viewer?.id ?? null, e.user_id, !!e.is_primary, !!e.private)) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }
  const info: EventInfo = {
    title: e.title,
    start: e.start_ms,
    end: e.end_ms,
    allDay: !!e.all_day,
    tentative: !!e.tentative,
    label: e.label,
    personId: e.user_id,
    person: e.person,
    personTimezone: e.person_tz,
    description: e.description,
    location: e.location,
    meetLink: e.meet_link,
    htmlLink: e.html_link,
  };
  return NextResponse.json(info, { headers: { "Cache-Control": "no-store" } });
}
