import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { authUrl } from "@/lib/server/google";
import { STATE_COOKIE, cookieOptions, googleConfigured } from "@/lib/server/secrets";
import { getConfig } from "@/lib/server/sync";
import { appUrl } from "@/lib/server/viewer";

/** Start "Sign in with Google". */
export function GET(request: NextRequest) {
  if (!googleConfigured()) return NextResponse.redirect(appUrl(request, "/?signin=unavailable"));
  const state = randomBytes(24).toString("base64url");
  const res = NextResponse.redirect(
    authUrl({
      origin: appUrl(request, "/").origin,
      state,
      domain: getConfig()?.googleDomain ?? null,
    }),
  );
  res.cookies.set(STATE_COOKIE, state, cookieOptions(600));
  return res;
}
