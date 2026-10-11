import { NextResponse } from "next/server";
import { requestSync } from "@/lib/server/sync";

export async function POST() {
  const result = requestSync();
  return NextResponse.json(result, { status: result.accepted ? 202 : 429 });
}
