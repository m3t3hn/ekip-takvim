import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/server/db";
import { SESSION_COOKIE, cookieOptions, isDemo, sessionValue } from "@/lib/server/secrets";
import { appUrl } from "@/lib/server/viewer";

/** Demo only: sign in as one of the made-up people, no Google involved. */
export function GET(request: NextRequest) {
  const user = getUser(request.nextUrl.searchParams.get("as") ?? "");
  // Made-up people only, never someone who signed in with Google.
  if (!isDemo() || !user || user.google_sub) return NextResponse.redirect(appUrl(request, "/"));
  const res = NextResponse.redirect(appUrl(request, "/settings"));
  const session = sessionValue(user);
  res.cookies.set(SESSION_COOKIE, session.value, cookieOptions(session.maxAge));
  return res;
}
