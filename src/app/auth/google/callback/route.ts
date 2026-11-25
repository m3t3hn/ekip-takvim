import { NextResponse, type NextRequest } from "next/server";
import { upsertGoogleUser } from "@/lib/server/db";
import { GoogleError, exchangeCode, keepSignInToken, listCalendars } from "@/lib/server/google";
import { SESSION_COOKIE, STATE_COOKIE, cookieOptions, decrypt, encrypt, googleConfigured, sessionValue } from "@/lib/server/secrets";
import { getConfig, syncOne } from "@/lib/server/sync";
import { appUrl } from "@/lib/server/viewer";

function fail(request: NextRequest, reason: string) {
  const res = NextResponse.redirect(appUrl(request, `/?signin=${encodeURIComponent(reason)}`));
  res.cookies.delete(STATE_COOKIE);
  return res;
}

/** A stored refresh token, or null when there's none this server can read (SESSION_SECRET changed). */
function readable(sealed: string | null): string | null {
  try {
    return sealed ? decrypt(sealed) : null;
  } catch {
    return null;
  }
}

/** Google sends people back here after they pick an account and allow access. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const config = getConfig();
  if (!googleConfigured() || !config) return fail(request, "unavailable");
  if (params.get("error")) return fail(request, "cancelled");
  const state = request.cookies.get(STATE_COOKIE)?.value;
  const code = params.get("code");
  if (!code || !state || params.get("state") !== state) return fail(request, "expired");

  try {
    const google = await exchangeCode(code, appUrl(request, "/").origin);
    const domain = config.googleDomain;
    if (domain && (google.domain !== domain || !google.email.endsWith(`@${domain}`))) {
      return fail(request, "domain");
    }
    // A new person starts in their Google Calendar's own zone.
    let timezone = config.timezone;
    if (google.calendarAccess) {
      const primary = (await listCalendars(google.accessToken).catch(() => [])).find((c) => c.primary);
      if (primary?.timeZone) timezone = primary.timeZone;
    }
    const { user, created } = upsertGoogleUser({
      sub: google.sub,
      email: google.email,
      name: google.name,
      timezone,
      refreshToken: google.refreshToken ? encrypt(google.refreshToken) : null,
      calendarAccess: google.calendarAccess,
    });
    // Their next Google request uses this sign-in's token, which carries what they
    // just allowed, or a newer one: it replaces whatever was kept for the refresh
    // token now stored, theirs from before when Google sent none.
    const refreshToken = google.refreshToken ?? readable(user.refresh_token);
    if (refreshToken) keepSignInToken(refreshToken, google);
    void syncOne(user.id);

    const res = NextResponse.redirect(appUrl(request, created || !google.calendarAccess ? "/settings" : "/"));
    const session = sessionValue(user);
    res.cookies.set(SESSION_COOKIE, session.value, cookieOptions(session.maxAge));
    res.cookies.delete(STATE_COOKIE);
    return res;
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", msg: "sign-in failed", scope: "auth", error: err instanceof GoogleError ? err.message : String(err) }));
    return fail(request, "failed");
  }
}
