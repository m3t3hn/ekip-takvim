import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { bookingAllowed } from "@/lib/server/booking-setting";
import { BOOKING_STATE, authUrl } from "@/lib/server/google";
import { STATE_COOKIE, cookieOptions, googleConfigured } from "@/lib/server/secrets";
import { getConfig } from "@/lib/server/sync";
import { appUrl } from "@/lib/server/viewer";

/**
 * Start "Sign in with Google". With ?booking=1, Allow access on My settings,
 * it also asks to add booked meetings to their Google Calendar: only while
 * booking links are on, and otherwise it's an ordinary sign-in. Allow access
 * comes back to My settings' booking links however it ends (see the callback).
 */
export function GET(request: NextRequest) {
  const booking = request.nextUrl.searchParams.get("booking") === "1" && bookingAllowed();
  if (!googleConfigured()) {
    return NextResponse.redirect(appUrl(request, booking ? "/settings?access=unavailable#booking" : "/?signin=unavailable"));
  }
  const state = randomBytes(24).toString("base64url") + (booking ? BOOKING_STATE : "");
  const res = NextResponse.redirect(
    authUrl({
      origin: appUrl(request, "/").origin,
      state,
      domain: getConfig()?.googleDomain ?? null,
      booking,
    }),
  );
  res.cookies.set(STATE_COOKIE, state, cookieOptions(600));
  return res;
}
