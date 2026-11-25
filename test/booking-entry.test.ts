import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bookingApp } from "./booking-helpers";
import { captureConsole } from "./link-helpers";
import { collapse, fakeBrowser, mount, textOf, type HostNode, type Ui } from "./ui-harness";

// Booking links' quick wins on the host's side (run 2026-11-25-ekip-quick-wins-host),
// criterion 4: a way in from the calendar page (the sidebar under Find a time,
// and the phone menu), /settings#booking, and a line in How it works. With
// BOOKING_LINKS off none of it is there (criterion 9). Written from the
// criteria; the pages were read only for how Next calls them.
//
// The calendar page is src/app/page.tsx called as Next calls it; its App is
// mounted as the server renders it (no effects), then clicked: the ☰ button
// on a phone-wide screen, and How it works.
const jar = vi.hoisted(() => ({ session: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ekip_session" && jar.session ? { name, value: jar.session } : undefined),
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} }),
}));

process.env.DATABASE_PATH = ":memory:";
process.env.SESSION_SECRET = "e".repeat(40);
process.env.CONFIG_YAML = "timezone: Europe/Istanbul\nhorizon_days: 30\n";
process.env.CALENDAR_LINKS = "private";
process.env.BOOKING_LINKS = "on";
process.env.DEMO_MODE = "true";
process.env.APP_URL = "https://cal.example.com";
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.EXPOSURE;

const app = await bookingApp(jar);
const { db } = app;
const { default: CalendarPage } = await import("@/app/page");
const { default: SettingsPage } = await import("@/app/settings/page");

let lines: string[] = [];
const network: string[] = [];
beforeAll(() => {
  lines = captureConsole();
});
beforeEach(() => {
  db.resetAll();
  app.signOut();
  process.env.BOOKING_LINKS = "on";
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    network.push(String(input instanceof Request ? input.url : input));
    throw new TypeError("test: no network");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.BOOKING_LINKS = "on";
  // The demo makes no Google request (criterion 9): not from the calendar page, its menu or How it works.
  expect(network.filter((u) => /google/.test(u))).toEqual([]);
  expect(lines.join("\n")).not.toMatch(/googleapis|accounts\.google/);
});

/** The calendar page as Next renders it, for whoever is signed in. */
async function calendar(query: Record<string, string> = {}) {
  const element = await CalendarPage({ params: Promise.resolve({}), searchParams: Promise.resolve(query) } as never);
  return mount(element, { effects: false });
}

const sidebars = (ui: Ui) => ui.all().filter((n) => n.tag === "aside" && n.props["aria-label"] === "Sidebar");
const interactive = (ui: Ui, within: HostNode) => ui.all(within).filter((n) => n.tag === "a" || n.tag === "button" || n.tag === "input" || n.tag === "select");

/** The Booking links entry in this sidebar, if any: what it's named and where it goes, and what comes before it. */
function entryIn(ui: Ui, sidebar: HostNode) {
  const all = interactive(ui, sidebar);
  const i = all.findIndex((n) => ui.nameOf(n) === "Booking links");
  if (i < 0) return null;
  return { node: all[i], href: all[i].props.href, before: ui.nameOf(all[i - 1] ?? all[i]) };
}

/** Open the phone menu (☰) on a phone-wide screen; the sidebar it shows. */
async function phoneMenu(ui: Ui): Promise<HostNode> {
  fakeBrowser("https://cal.example.com/", { width: 375 }).install();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  const before = sidebars(ui).length;
  await ui.click(ui.getNamed("Main menu"));
  const after = sidebars(ui);
  expect(after.length, "the menu shows a sidebar").toBe(before + 1);
  return after[after.length - 1];
}

/** Open How it works from the header; the dialog's text. */
async function howItWorks(ui: Ui): Promise<string> {
  await ui.click(ui.getNamed("How it works"));
  const dialog = ui.get((n) => n.props.role === "dialog", "the How it works dialog");
  return collapse(textOf(dialog));
}

/** Someone signed in to the demo: a person in the database, with a session. */
function signedIn(name = "Entry Host") {
  const host = app.person(name);
  app.signIn(host.id);
  return host;
}

describe("a way in from the calendar (criterion 4)", () => {
  it("while booking links are on, a signed-in person has Booking links under Find a time, going to /settings#booking", async () => {
    signedIn();
    const ui = await calendar();
    const [sidebar] = sidebars(ui);
    expect(sidebar, "the sidebar").toBeTruthy();
    const entry = entryIn(ui, sidebar);
    expect(entry, ui.html(sidebar).slice(0, 2000)).not.toBeNull();
    expect(entry!.href).toBe("/settings#booking");
    expect(entry!.node.tag).toBe("a");
    expect(entry!.before, "right under Find a time").toBe("Find a time");
  });

  it("and in the phone menu (☰), under Find a time too", async () => {
    signedIn();
    const ui = await calendar();
    const menu = await phoneMenu(ui);
    const entry = entryIn(ui, menu);
    expect(entry).not.toBeNull();
    expect(entry!.href).toBe("/settings#booking");
    expect(entry!.before).toBe("Find a time");
  });

  it("isn't there for someone who isn't signed in, in the sidebar or the phone menu", async () => {
    signedIn("Someone Else");
    app.signOut();
    const ui = await calendar();
    expect(sidebars(ui).length).toBeGreaterThan(0);
    for (const sidebar of [...sidebars(ui), await phoneMenu(ui)]) expect(entryIn(ui, sidebar)).toBeNull();
    expect(ui.all().some((n) => String(n.props.href ?? "").includes("#booking"))).toBe(false);
  });

  it("isn't there while booking links are off, in the sidebar or the phone menu", async () => {
    for (const setting of ["off", "", "yes"]) {
      process.env.BOOKING_LINKS = setting;
      signedIn(`Off Host ${setting}`);
      const ui = await calendar();
      for (const sidebar of [...sidebars(ui), await phoneMenu(ui)]) expect(entryIn(ui, sidebar), `BOOKING_LINKS=${setting}`).toBeNull();
      expect(ui.all().some((n) => String(n.props.href ?? "").includes("#booking"))).toBe(false);
      expect(ui.text()).not.toMatch(/booking/i);
      vi.unstubAllGlobals();
    }
  });

  it("is in the HTML the server sends, for a signed-in person", async () => {
    signedIn();
    const html = renderToStaticMarkup(await CalendarPage({ params: Promise.resolve({}), searchParams: Promise.resolve({}) } as never));
    expect(html).toMatch(/<a[^>]*href="\/settings#booking"[^>]*>(?:(?!<\/a>)[\s\S])*Booking links/);
    process.env.BOOKING_LINKS = "off";
    const off = renderToStaticMarkup(await CalendarPage({ params: Promise.resolve({}), searchParams: Promise.resolve({}) } as never));
    expect(off).not.toContain("#booking");
    expect(off).not.toMatch(/booking/i);
  });
});

describe("/settings#booking (criterion 4)", () => {
  it("is the Booking links section, in the HTML the server sends, so a fresh load opens there", async () => {
    signedIn();
    const html = renderToStaticMarkup(await SettingsPage({ params: Promise.resolve({}), searchParams: Promise.resolve({}) } as never)).replace(/<!-- -->/g, "");
    const ids = [...html.matchAll(/\sid="booking"/g)];
    expect(ids, "one element is #booking").toHaveLength(1);
    // That element holds the Booking links heading and its links.
    const ui = await mount(await SettingsPage({ params: Promise.resolve({}), searchParams: Promise.resolve({}) } as never), { effects: false });
    const target = ui.get((n) => n.props.id === "booking", "#booking");
    const heading = ui.all(target).find((n) => /^h[1-6]$/.test(n.tag));
    expect(collapse(textOf(heading!))).toBe("Booking links");
    expect(ui.text(target)).toContain("New booking link");
    expect(ui.text(target)).toContain("Upcoming bookings");
  });

  it("isn't there while booking links are off", async () => {
    process.env.BOOKING_LINKS = "off";
    signedIn();
    const html = renderToStaticMarkup(await SettingsPage({ params: Promise.resolve({}), searchParams: Promise.resolve({}) } as never));
    expect(html).not.toContain('id="booking"');
    expect(html).not.toMatch(/booking link/i);
  });
});

describe("How it works (criterion 4)", () => {
  it("has a line on booking links while they're on: where they are and what they do", async () => {
    for (const who of ["signed in", "not signed in"]) {
      if (who === "signed in") signedIn();
      else app.signOut();
      const text = await howItWorks(await calendar());
      expect(text, who).toMatch(/booking links/i);
      // Where: My settings, or the entry under Find a time.
      expect(text, who).toMatch(/My settings/);
      // What: someone books one of your free times.
      expect(text, who).toMatch(/\bbook\b/i);
      expect(text, who).toMatch(/free time/i);
      vi.unstubAllGlobals();
    }
  });

  it("has none while they're off", async () => {
    signedIn();
    for (const setting of ["off", ""]) {
      process.env.BOOKING_LINKS = setting;
      const text = await howItWorks(await calendar());
      expect(text, `BOOKING_LINKS=${setting}`).not.toMatch(/book/i);
      expect(text).toContain("How Ekip Takvim works");
    }
  });
});
