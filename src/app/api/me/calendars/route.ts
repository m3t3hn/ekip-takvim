import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { normalizeLink } from "@/lib/server/calendar-link";
import { buildConfig } from "@/lib/server/config";
import { addLinkCalendar, getUser, listCalendars, markLinkRequested } from "@/lib/server/db";
import { linksAllowed } from "@/lib/server/link-setting";
import { mySettings } from "@/lib/server/me";
import { getConfig, linkProblem, readLink, storeLinkRead, type LinkRead } from "@/lib/server/sync";
import { sessionUserId } from "@/lib/server/viewer";

const NO_STORE = { "Cache-Control": "no-store" };
/** Calendar links one person can add. */
const MAX_LINKS = 10;
/** The same rule as a label saved with PUT /api/me. */
const Label = z.string().trim().min(1).max(40);

const problem = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * Add a calendar link: { url, label }. It's read first, so a link that doesn't
 * work never becomes a calendar; then it's stored with its busy times, and the
 * answer is my settings, as GET /api/me gives them. Nothing of the link but its
 * host ever comes back, in this answer or any other.
 */
export async function POST(request: NextRequest) {
  const id = await sessionUserId();
  const user = id ? getUser(id) : null;
  if (!user) return problem(401, "Sign in first");
  if (!linksAllowed()) return problem(403, "This server doesn't take calendar links.");
  const body = (await request.json().catch(() => null)) as { url?: unknown; label?: unknown } | null;
  const label = Label.safeParse(body?.label);
  if (!label.success) return problem(400, "Give the calendar a label, up to 40 characters.");
  let url: URL;
  try {
    url = normalizeLink(typeof body?.url === "string" ? body.url : "");
  } catch (err) {
    return problem(400, linkProblem(err));
  }
  const full = () => listCalendars(user.id).filter((c) => c.kind === "link").length >= MAX_LINKS;
  if (full()) return problem(409, `You can add up to ${MAX_LINKS} calendar links. Remove one first.`);

  const requested = Date.now();
  let read: LinkRead;
  try {
    read = await readLink(url.href, user.timezone, getConfig() ?? buildConfig({}));
  } catch (err) {
    return problem(400, linkProblem(err));
  }
  // Another link may have been added while this one was read.
  if (full()) return problem(409, `You can add up to ${MAX_LINKS} calendar links. Remove one first.`);
  const calendarId = addLinkCalendar(user.id, url.href, label.data);
  storeLinkRead(user.id, calendarId, read);
  // Rounds count from this read, as from any other.
  markLinkRequested(user.id, calendarId, requested);
  return NextResponse.json(mySettings(user.id), { headers: NO_STORE });
}
