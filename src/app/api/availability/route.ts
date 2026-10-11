import { NextResponse, type NextRequest } from "next/server";
import { getAvailability, getSettings, waitForFirstSync } from "@/lib/server/sync";
import { validTimezone } from "@/lib/server/config";
import { currentViewer } from "@/lib/server/viewer";
import { isDayKey } from "@/lib/time";

const MAX_DAYS = 62;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const start = params.get("start");
  const days = Number(params.get("days") ?? "1");
  // The viewer's zone: days are calendar days there. Defaults to the team's.
  const tz = params.get("tz") ?? undefined;
  if (!isDayKey(start) || !Number.isInteger(days) || days < 1 || days > MAX_DAYS || (tz && !validTimezone(tz))) {
    return NextResponse.json(
      { error: `Use ?start=YYYY-MM-DD&days=1..${MAX_DAYS}[&tz=Area/City]` },
      { status: 400 },
    );
  }

  // On a cold start, give the first sync a moment so the page isn't empty.
  await waitForFirstSync(8_000);
  // Which event titles come back depends on who is asking.
  const viewer = await currentViewer();
  const data = getAvailability(start, days, tz, viewer?.id ?? null);
  if (!data) {
    return NextResponse.json(
      { error: getSettings(null).configError ?? "Not configured" },
      { status: 503 },
    );
  }
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
