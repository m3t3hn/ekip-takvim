import { afterEach, describe, expect, it } from "vitest";

// Booking links' quick wins (run 2026-11-25-ekip-quick-wins-visitor),
// criterion 1: once a visitor books, the page's address is the booking's
// cancel link, so it reaches no other site. The /book/ pages (and what they
// load from /api/book/) send Referrer-Policy: no-referrer, whatever else the
// proxy answers; every other path keeps the policy next.config.ts gives every
// answer. And the dev server's request log still leaves the cancel link out,
// for a reload of that address too. src/proxy.ts is called as
// booking-proxy.test.ts calls it. No network: Access is only asked about
// requests without a token, which it refuses before fetching any key.
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "y".repeat(40);
delete process.env.APP_URL;
delete process.env.DEMO_MODE;

const { NextRequest } = await import("next/server");
const { proxy } = await import("@/proxy");
const { default: nextConfig } = await import("../next.config");

const ORIGIN = "https://cal.example.com";
const TOKEN = "Zy8xW6vU4tS2rQ0pO8nM6lK4jI2hG0fE";
const ENV = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "BASIC_AUTH_USER", "BASIC_AUTH_PASSWORD", "EXPOSURE", "BOOKING_LINKS"];
const SETUPS = ["none", "cloudflare", "basic", "exposed", "all three"] as const;
function configure(setup: (typeof SETUPS)[number], booking: string | undefined) {
  for (const name of ENV) delete process.env[name];
  if (setup === "cloudflare" || setup === "all three") {
    process.env.CF_ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com";
    process.env.CF_ACCESS_AUD = "aud-of-ekip-takvim";
  }
  if (setup === "basic" || setup === "all three") {
    process.env.BASIC_AUTH_USER = "team";
    process.env.BASIC_AUTH_PASSWORD = "correct horse battery staple";
  }
  if (setup === "exposed" || setup === "all three") process.env.EXPOSURE = "exposed";
  if (booking !== undefined) process.env.BOOKING_LINKS = booking;
}
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

const policy = async (path: string) => (await proxy(new NextRequest(`${ORIGIN}${path}`))).headers.get("referrer-policy");

const VISITOR_PATHS = [
  `/book/${TOKEN.slice(0, 22)}`,
  `/book/${TOKEN.slice(0, 22)}?from=mail`,
  `/book/cancel/${TOKEN}`,
  `/book/cancel/${TOKEN}?_rsc=1abcd`,
  `/api/book/${TOKEN.slice(0, 22)}`,
  `/api/book/cancel/${TOKEN}`,
];
const OTHER_PATHS = ["/", "/settings", "/status", "/sign-in", "/auth/google", "/api/me", "/api/me/booking-links", "/api/me/bookings/x/cancel", "/api/availability", "/book", "/booking/x", "/api/booking/x"];

describe("Referrer-Policy on the visitor's pages", () => {
  it("is no-referrer on /book/ and /api/book/ while booking links are on, behind every check", async () => {
    for (const setup of SETUPS) {
      configure(setup, "on");
      for (const path of VISITOR_PATHS) expect(await policy(path), `${setup} ${path}`).toBe("no-referrer");
    }
  });

  it("is no-referrer on those addresses while booking links are off too, whatever the checks answer", async () => {
    for (const setup of SETUPS) {
      configure(setup, "off");
      for (const path of VISITOR_PATHS) expect(await policy(path), `${setup} ${path}`).toBe("no-referrer");
    }
  });

  it("isn't set by the proxy anywhere else: those paths keep next.config.ts's policy", async () => {
    for (const setup of SETUPS) {
      for (const booking of ["on", "off"]) {
        configure(setup, booking);
        for (const path of OTHER_PATHS) expect(await policy(path), `${setup} ${booking} ${path}`).toBeNull();
      }
    }
    const headers = await nextConfig.headers!();
    const all = headers.find((h) => h.source === "/:path*")!.headers;
    expect(all.find((h) => h.key === "Referrer-Policy")?.value).toBe("strict-origin-when-cross-origin");
  });
});

describe("the request log (criterion 1)", () => {
  it("still leaves out the cancel link's address, and the page's reload of it", () => {
    const ignore = nextConfig.logging && typeof nextConfig.logging === "object" ? nextConfig.logging.incomingRequests : undefined;
    const patterns = ignore && typeof ignore === "object" ? ignore.ignore ?? [] : [];
    const ignored = (url: string) => patterns.some((p) => p.test(url));
    for (const url of [`/book/cancel/${TOKEN}`, `/book/cancel/${TOKEN}?_rsc=1abcd`, `/api/book/cancel/${TOKEN}`]) expect(ignored(url), url).toBe(true);
    // The booking page's own address isn't a secret: it's logged as before.
    expect(ignored(`/book/${TOKEN.slice(0, 22)}`)).toBe(false);
  });
});
