// How the app is reached, from EXPOSURE:
// - internal (the default): only from your network or VPN, so viewing needs
//   no sign-in.
// - exposed: from the internet, so every page needs a sign-in with a company
//   Google account. Signing in also adds the person's calendars.

export type Exposure = "internal" | "exposed";

/** The EXPOSURE setting; anything but the two values is refused. */
export function exposureSetting(): Exposure | "invalid" {
  const value = (process.env.EXPOSURE ?? "").trim().toLowerCase();
  if (value === "" || value === "internal") return "internal";
  if (value === "exposed") return "exposed";
  return "invalid";
}

// Open even when exposed: the sign-in page and the routes that sign people in
// and out, and the health check. Static files and icons never reach the proxy.
const OPEN = [/^\/healthz$/, /^\/sign-in$/, /^\/auth\/(google|google\/callback|demo|logout)$/];

/** What to do with a request: let it through, send it to sign in, or refuse it (APIs). */
export function gate(pathname: string, exposure: Exposure, signedIn: boolean): "pass" | "sign-in" | "unauthorized" {
  if (exposure === "internal" || signedIn || OPEN.some((path) => path.test(pathname))) return "pass";
  return pathname.startsWith("/api/") ? "unauthorized" : "sign-in";
}

/**
 * Why an exposed setup isn't safe to run, if it isn't: without a domain, any
 * account the OAuth client accepts could sign in and see everyone's calendar;
 * without https, the session cookie travels in the clear. http://localhost is
 * allowed for trying it out.
 */
export function exposureProblem(googleDomain: string | null, appUrl: string | undefined): string | null {
  if (!googleDomain) {
    return "EXPOSURE=exposed needs google_domain in the config, or any account the OAuth client accepts could sign in";
  }
  const url = appUrl ?? "";
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
  if (!url.startsWith("https://") && !local) return "EXPOSURE=exposed needs APP_URL to be an https:// address";
  return null;
}
