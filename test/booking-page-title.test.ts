import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldServeStreamingMetadata } from "next/dist/server/lib/streaming-metadata";
import { LINK, bookingApp, type Page } from "./booking-helpers";

// Booking links' quick wins (run 2026-11-25-ekip-quick-wins-visitor):
// - criterion 9: for a link that can be booked (it exists, it's on, its host
//   is still here), /book/<id>'s title is "<link title> with <host name>", in
//   the HTML a link preview gets without running scripts (Slack, WhatsApp,
//   Teams). Every link that can't be booked keeps "Book a time · Ekip Takvim",
//   so the title can't tell them apart. noindex stays. The cancel page's
//   title stays general and never shows the booking.
// - criterion 2: GET /api/book/<id> says whether the link adds a Meet link.
// generateMetadata is called as Next calls it, with its params as a promise.
// Whether a previewer gets that title in <head> is Next's choice per user
// agent (htmlLimitedBots), checked here with Next's own function and the
// app's config; the HTML itself needs a server, which the lead checks.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));

process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "p".repeat(40);
process.env.CONFIG_YAML = "timezone: UTC\nhorizon_days: 30\n";
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.DEMO_MODE = "true";
process.env.APP_URL = "https://cal.example.com";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const app = await bookingApp(jar);
const bookPage = await import("@/app/book/[id]/page");
const cancelPage = await import("@/app/book/cancel/[token]/page");
const { default: nextConfig } = await import("../next.config");

const GENERAL = "Book a time · Ekip Takvim";
const metadataFor = (id: string) => bookPage.generateMetadata({ params: Promise.resolve({ id }) } as never);

beforeEach(() => {
  app.db.resetAll();
  app.signOut();
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("test: no network");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
});

describe("the booking page's title (criterion 9)", () => {
  it("is '<link title> with <host name>' for a link that can be booked, still noindex, with no Referer", async () => {
    const { id } = await app.hostWithLink({ title: "Intro call" }, { name: "Zeynep Şahin" });
    expect(await metadataFor(id)).toEqual({ title: "Intro call with Zeynep Şahin", robots: { index: false, follow: false }, referrer: "no-referrer" });
  });

  it("follows the link's title and the host's name as they are now", async () => {
    const { id, host } = await app.hostWithLink({ title: "Intro call" }, { name: "Zeynep Şahin" });
    app.signIn(host.id);
    expect((await app.updateLink(id, { ...LINK, title: "Portfolio review", active: true })).status).toBe(200);
    app.signOut();
    expect((await metadataFor(id)).title).toBe("Portfolio review with Zeynep Şahin");
  });

  it("is shown for a host who hasn't allowed access yet: the link exists, is on, and its host is here", async () => {
    const { id } = await app.hostWithLink({ title: "Intro call" }, { name: "Zeynep Şahin", bookingAccess: false });
    expect((await metadataFor(id)).title).toBe("Intro call with Zeynep Şahin");
  });

  it("stays 'Book a time · Ekip Takvim', the same in every way, for every link that can't be booked", async () => {
    const { id: offLink, host: offHost } = await app.hostWithLink({ title: "Secret Off Title" }, { name: "Secret Off Host" });
    app.signIn(offHost.id);
    expect((await app.updateLink(offLink, { ...LINK, title: "Secret Off Title", active: false })).status).toBe(200);
    app.signOut();
    const { id: goneLink, host: goneHost } = await app.hostWithLink({ title: "Secret Gone Title" }, { name: "Secret Gone Host" });
    app.db.deleteUser(goneHost.id);
    const { id: open } = await app.hostWithLink({ title: "Secret Open Title" }, { name: "Secret Open Host" });

    const answers: [string, unknown][] = [
      ["unknown", await metadataFor("doesNotExist")],
      ["unknown, token-shaped", await metadataFor("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")],
      ["off", await metadataFor(offLink)],
      ["host left", await metadataFor(goneLink)],
    ];
    for (const setting of [undefined, "", "off", "maybe"]) {
      if (setting === undefined) delete process.env.BOOKING_LINKS;
      else process.env.BOOKING_LINKS = setting;
      answers.push([`BOOKING_LINKS=${setting}, an open link`, await metadataFor(open)]);
    }
    for (const [why, m] of answers) {
      expect(m, why).toEqual({ title: GENERAL, robots: { index: false, follow: false }, referrer: "no-referrer" });
      expect(JSON.stringify(m), why).not.toMatch(/Secret/);
    }
  });

  it("is in the HTML a link preview gets: Next blocks for the metadata for Slack's, WhatsApp's and Teams' previewers", () => {
    // The app keeps Next's own list of HTML-limited bots.
    expect(nextConfig.htmlLimitedBots).toBeUndefined();
    const previewers = {
      Slack: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      WhatsApp: "WhatsApp/2.23.20.0 A",
      Teams: "Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com",
    };
    for (const [who, ua] of Object.entries(previewers)) {
      expect(shouldServeStreamingMetadata(ua, nextConfig.htmlLimitedBots as never), who).toBe(false);
    }
    // A browser gets it streamed, as any page's.
    expect(shouldServeStreamingMetadata("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", nextConfig.htmlLimitedBots as never)).toBe(true);
  });

  it("is still a 404 page while booking links are off", async () => {
    const { id } = await app.hostWithLink();
    process.env.BOOKING_LINKS = "off";
    const thrown = await bookPage.default({ params: Promise.resolve({ id }) } as never).then(
      () => null,
      (e: { digest?: string }) => e,
    );
    expect(thrown?.digest).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });
});

describe("the cancel page's title (criterion 9)", () => {
  it("stays general, set once for every booking: it can't show one", () => {
    expect(cancelPage.metadata).toEqual({ title: "Cancel a booking · Ekip Takvim", robots: { index: false, follow: false }, referrer: "no-referrer" });
    expect("generateMetadata" in cancelPage).toBe(false);
  });
});

describe("GET /api/book/[id] says whether the link adds a Meet link (criterion 2)", () => {
  it("meet is true with Meet on, false with it off, and follows a change", async () => {
    const { id: withMeet, host } = await app.hostWithLink({ meet: true });
    const { id: without } = await app.hostWithLink({ meet: false });
    const page = async (id: string) => (await app.page(id)).json as Page & { meet: unknown };
    expect((await page(withMeet)).meet).toBe(true);
    expect((await page(without)).meet).toBe(false);
    app.signIn(host.id);
    expect((await app.updateLink(withMeet, { ...LINK, title: "Now without Meet", meet: false, active: true })).status).toBe(200);
    app.signOut();
    expect((await page(withMeet)).meet).toBe(false);
  });
});
