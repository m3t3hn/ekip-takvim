import { NextResponse } from "next/server";
import { ensureStarted, getStatus } from "@/lib/server/sync";

export async function GET() {
  ensureStarted();
  return NextResponse.json(getStatus(), { headers: { "Cache-Control": "no-store" } });
}
