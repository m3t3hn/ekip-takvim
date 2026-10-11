import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isHexColor, normalizeColor } from "@/lib/colors";
import { validTimezone } from "@/lib/server/config";
import { deleteUser, getUser, takenColors, updateCalendarChoices, updateUser } from "@/lib/server/db";
import { revoke } from "@/lib/server/google";
import { mySettings } from "@/lib/server/me";
import { SESSION_COOKIE, decrypt } from "@/lib/server/secrets";
import { sessionUserId } from "@/lib/server/viewer";
import { getConfig, syncOne } from "@/lib/server/sync";

const NO_STORE = { "Cache-Control": "no-store" };
const unauthorized = () => NextResponse.json({ error: "Sign in first" }, { status: 401 });

export async function GET() {
  const id = await sessionUserId();
  const me = id ? mySettings(id) : null;
  return me ? NextResponse.json(me, { headers: NO_STORE }) : unauthorized();
}

const Body = z.object({
  team: z.string().nullable(),
  timezone: z.string(),
  color: z.string().refine(isHexColor, "a colour like #2f7de1"),
  calendars: z.array(z.object({ id: z.string(), label: z.string().trim().min(1).max(40), included: z.boolean() })).max(500),
});

/** Save team, zone, colour and which calendars count, under which label. */
export async function PUT(request: NextRequest) {
  const id = await sessionUserId();
  if (!id || !getUser(id)) return unauthorized();
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Every counted calendar needs a label (up to 40 characters)." }, { status: 400 });
  const body = parsed.data;
  const teams = getConfig()?.teams ?? [];
  if (body.team !== null && !teams.includes(body.team)) return NextResponse.json({ error: "Pick one of the listed teams." }, { status: 400 });
  if (!validTimezone(body.timezone)) return NextResponse.json({ error: "Unknown time zone." }, { status: 400 });
  const color = normalizeColor(body.color);
  const owner = takenColors(id).find((t) => t.color === color);
  if (owner) return NextResponse.json({ error: `That colour is ${owner.name}'s. Pick another one.` }, { status: 409 });

  updateUser(id, { team: body.team, timezone: body.timezone, color });
  updateCalendarChoices(id, body.calendars);
  // Newly counted calendars and a new zone (all-day events) need a fresh read.
  await syncOne(id);
  return NextResponse.json(mySettings(id), { headers: NO_STORE });
}

/** Remove me: forget my calendars and busy times, and give Google access back. */
export async function DELETE() {
  const id = await sessionUserId();
  const user = id ? getUser(id) : null;
  if (!user) return unauthorized();
  if (user.refresh_token) {
    try {
      await revoke(decrypt(user.refresh_token));
    } catch {}
  }
  deleteUser(user.id);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
