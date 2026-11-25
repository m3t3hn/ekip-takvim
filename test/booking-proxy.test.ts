import { afterEach, describe, expect, it } from "vitest";

// Booking links, criterion 9: src/proxy.ts. While BOOKING_LINKS=on, /book/...
// and /api/book/... skip Cloudflare Access, basic auth and the EXPOSURE gate;
// every other path, and those paths while booking is off, get the answers the
// proxy gave before this branch. Every answer under /book/ and /api/book/
// carries X-Robots-Tag: noindex. No network: Access is only asked about
// requests without a token, which it refuses before fetching any key.
process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "x".repeat(40);
delete process.env.APP_URL;
delete process.env.DEMO_MODE;

const { NextRequest } = await import("next/server");
const { proxy, config } = await import("@/proxy");

const ORIGIN = "https://cal.example.com";
const SETUPS = ["none", "cloudflare", "basic", "exposed", "basic and exposed", "all three"] as const;
type Setup = (typeof SETUPS)[number];

const ENV = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "BASIC_AUTH_USER", "BASIC_AUTH_PASSWORD", "EXPOSURE", "BOOKING_LINKS"];
function configure(setup: Setup, booking: string | undefined) {
  for (const name of ENV) delete process.env[name];
  if (setup === "cloudflare" || setup === "all three") {
    process.env.CF_ACCESS_TEAM_DOMAIN = "your-team.cloudflareaccess.com";
    process.env.CF_ACCESS_AUD = "aud-of-ekip-takvim";
  }
  if (setup === "basic" || setup === "basic and exposed" || setup === "all three") {
    process.env.BASIC_AUTH_USER = "team";
    process.env.BASIC_AUTH_PASSWORD = "correct horse battery staple";
  }
  if (setup === "exposed" || setup === "basic and exposed" || setup === "all three") process.env.EXPOSURE = "exposed";
  if (booking !== undefined) process.env.BOOKING_LINKS = booking;
}
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

type Seen = { status: number; body: string; type: string | null; location: string | null; auth: string | null; next: string | null };

async function ask(path: string): Promise<Seen & { robots: string | null }> {
  const res = await proxy(new NextRequest(`${ORIGIN}${path}`));
  return {
    status: res.status,
    body: await res.text(),
    type: res.headers.get("content-type"),
    location: res.headers.get("location"),
    auth: res.headers.get("www-authenticate"),
    next: res.headers.get("x-middleware-next"),
    robots: res.headers.get("x-robots-tag"),
  };
}
/** The answer without its X-Robots-Tag, which only booking paths get. */
const without = ({ status, body, type, location, auth, next }: Seen & { robots: string | null }): Seen => ({ status, body, type, location, auth, next });

// The answers the proxy gave before this branch (src/proxy.ts and
// src/lib/server/exposure.ts on feature/ics-links), for a request with no
// Access token, no credentials and no session.
const PASS: Seen = { status: 200, body: "", type: null, location: null, auth: null, next: "1" };
const OPEN_WHEN_EXPOSED = [/^\/healthz$/, /^\/sign-in$/, /^\/auth\/(google|google\/callback|demo|logout)$/];
function before(path: string, setup: Setup): Seen {
  const url = new URL(path, ORIGIN);
  if (setup === "cloudflare" || setup === "all three") {
    return { status: 403, body: "Open this app through Cloudflare Access", type: "text/plain;charset=UTF-8", location: null, auth: null, next: null };
  }
  if (setup === "basic" || setup === "basic and exposed") {
    return { status: 401, body: "Authentication required", type: "text/plain;charset=UTF-8", location: null, auth: 'Basic realm="Team availability", charset="UTF-8"', next: null };
  }
  if (setup === "exposed" && !OPEN_WHEN_EXPOSED.some((open) => open.test(url.pathname))) {
    if (url.pathname.startsWith("/api/")) {
      return { status: 401, body: '{"error":"Sign in first"}', type: "application/json", location: null, auth: null, next: null };
    }
    const to = new URL("/sign-in", ORIGIN);
    const reason = url.searchParams.get("signin");
    if (reason) to.searchParams.set("signin", reason);
    return { status: 307, body: "", type: null, location: to.href, auth: null, next: null };
  }
  return PASS;
}

const BOOKING = ["/book/x", "/book/Zx3_-9aQ", "/book/x?from=mail", "/book/cancel/tok3n", "/api/book/x", "/api/book/cancel/tok3n"];
const OTHER = [
  "/",
  "/?signin=denied",
  "/settings",
  "/status",
  "/sign-in",
  "/healthz",
  "/auth/google",
  "/auth/demo",
  "/api/me",
  "/api/me/booking-links",
  "/api/me/booking-links/x",
  "/api/me/bookings/x/cancel",
  "/api/availability",
  "/api/status",
  "/api/events/x",
  "/book",
  "/api/book",
  "/booking/x",
  "/bookx/y",
  "/api/booking",
  "/api/booking/x",
  "/api/bookx/y",
  "/xbook/y",
  "/x/book/y",
  "/api/me/book/x",
  "/api/x/book/y",
  "/Book/x",
  "/BOOK/x",
  "/API/book/x",
  "/api/Book/x",
  "/book%2Fx",
  "/api/book%2Fx",
  "/book/../api/me",
  "/book/x/../../settings",
];

describe("while booking is on", () => {
  it("lets /book/<x> and /api/book/<x> through Cloudflare Access with no token, basic auth with no credentials and EXPOSURE=exposed with no session", async () => {
    for (const booking of ["on", " ON ", "On"]) {
      for (const setup of SETUPS) {
        configure(setup, booking);
        for (const path of BOOKING) expect(without(await ask(path)), `${setup} ${booking} ${path}`).toEqual(PASS);
      }
    }
  });

  it("gives every other path the answer it got before this branch", async () => {
    for (const setup of SETUPS) {
      configure(setup, "on");
      for (const path of OTHER) {
        const seen = await ask(path);
        expect(without(seen), `${setup} ${path}`).toEqual(before(path, setup));
        expect(seen.robots, `${setup} ${path}`).toBeNull();
      }
    }
  });

  it("marks the booking paths' answers noindex", async () => {
    for (const setup of SETUPS) {
      configure(setup, "on");
      for (const path of BOOKING) expect((await ask(path)).robots ?? "", `${setup} ${path}`).toMatch(/noindex/i);
    }
  });
});

describe("while booking is off", () => {
  const OFF = [undefined, "", "off", "OFF", "yes", "public"];

  it("gives /book/... and /api/book/... the answers the checks give any other path", async () => {
    for (const booking of OFF) {
      for (const setup of SETUPS) {
        configure(setup, booking);
        for (const path of BOOKING) expect(without(await ask(path)), `${setup} ${booking} ${path}`).toEqual(before(path, setup));
        // The same as a page and an API elsewhere.
        expect(without(await ask("/book/x")), `${setup} ${booking}`).toEqual(without(await ask("/settings")));
        expect(without(await ask("/api/book/x")), `${setup} ${booking}`).toEqual(without(await ask("/api/me")));
      }
    }
  });

  it("gives every other path the answer it got before this branch", async () => {
    for (const booking of OFF) {
      for (const setup of SETUPS) {
        configure(setup, booking);
        for (const path of OTHER) expect(without(await ask(path)), `${setup} ${booking} ${path}`).toEqual(before(path, setup));
      }
    }
  });

  it("still marks the booking paths' answers noindex", async () => {
    for (const setup of SETUPS) {
      configure(setup, "off");
      for (const path of BOOKING) expect((await ask(path)).robots ?? "", `${setup} ${path}`).toMatch(/noindex/i);
    }
  });
});

describe("which requests reach the proxy", () => {
  it("is unchanged: everything but the health check, static files and icons", () => {
    expect(config.matcher).toEqual([
      "/((?!healthz|_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|icons/).*)",
    ]);
  });
});
