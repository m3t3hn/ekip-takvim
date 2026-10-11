import { NextResponse } from "next/server";
import { getUser } from "@/lib/server/db";
import { mySettings } from "@/lib/server/me";
import { sessionUserId } from "@/lib/server/viewer";
import { refreshMine } from "@/lib/server/sync";

/** Re-read my calendar list from Google (to pick up newly shared calendars) and sync them. */
export async function POST() {
  const id = await sessionUserId();
  if (!id || !getUser(id)) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  await refreshMine(id);
  return NextResponse.json(mySettings(id), { headers: { "Cache-Control": "no-store" } });
}
