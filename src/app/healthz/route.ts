import { NextResponse } from "next/server";
import { ensureStarted, getStatus } from "@/lib/server/sync";

// Liveness only: a broken calendar or config must not get the container
// restarted, so this stays 200 and reports details in the body.
export async function GET() {
  ensureStarted();
  const status = getStatus();
  return NextResponse.json(
    {
      status: status.configError ? "degraded" : "ok",
      version: status.version,
      syncedAt: status.syncedAt,
      calendars: status.calendars.length,
      failing: status.calendars.filter((f) => f.state === "error").length,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
