import { NextResponse, type NextRequest } from "next/server";
import { bumpSessionVersion } from "@/lib/server/db";
import { SESSION_COOKIE } from "@/lib/server/secrets";
import { appUrl, sessionUser } from "@/lib/server/viewer";

/** Sign out everywhere: every session of this person ends, not just this browser's cookie. */
export async function POST(request: NextRequest) {
  const user = await sessionUser();
  if (user) bumpSessionVersion(user.id);
  const res = NextResponse.redirect(appUrl(request, "/"), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
