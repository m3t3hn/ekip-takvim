import { NextResponse, type NextRequest } from "next/server";
import { accessCheck, validAccessToken } from "@/lib/server/access";

// Who can reach the app at all, before any page or API runs. Both checks are
// off unless configured:
// - Cloudflare Access (CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD): only requests
//   that came through Access for this app.
// - HTTP basic auth (BASIC_AUTH_USER and BASIC_AUTH_PASSWORD), for when the
//   app can't sit behind the VPN or Cloudflare Access.
export async function proxy(request: NextRequest) {
  const access = accessCheck();
  if (access === "incomplete") {
    return new NextResponse("Set both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD, or neither", { status: 500 });
  }
  if (access && !(await validAccessToken(request.headers.get("cf-access-jwt-assertion"), access))) {
    return new NextResponse("Open this app through Cloudflare Access", { status: 403 });
  }

  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!user && !password) return NextResponse.next();
  // Half a setup fails closed, so a missing value can't quietly open the app.
  if (!user || !password) {
    return new NextResponse("Set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD, or neither", { status: 500 });
  }

  const header = request.headers.get("authorization") ?? "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try {
      decoded = atob(encoded);
    } catch {}
    const sep = decoded.indexOf(":");
    if (
      sep > 0 &&
      safeEqual(decoded.slice(0, sep), user) &&
      safeEqual(decoded.slice(sep + 1), password)
    ) {
      return NextResponse.next();
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Team availability", charset="UTF-8"' },
  });
}

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export const config = {
  // The health check, static files, icons and the manifest stay open: nothing
  // in them is about anyone.
  matcher: ["/((?!healthz|_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|icons/).*)"],
};
